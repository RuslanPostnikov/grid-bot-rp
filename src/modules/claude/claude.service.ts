import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { OnEvent, EventEmitter2 } from '@nestjs/event-emitter';
import Anthropic from '@anthropic-ai/sdk';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  BOT_EVENTS,
  type BotResumedPayload,
  type RegimeChangePayload,
} from '../../common/events.js';
import { PrismaService } from '../../prisma.service.js';
import { ExchangeService } from '../exchange/exchange.service.js';
import { GridService } from '../grid/grid.service.js';
import { RiskService } from '../risk/risk.service.js';
import { withRetry } from '../../common/retry.js';
import { ccxtFreeUsedAssetTotal } from '../../common/ccxt-wallet.js';
import {
  SYSTEM_PROMPT,
  buildUserPrompt,
  parseClaudeResponse,
} from './claude-prompt.js';
import type {
  MarketSnapshot,
  ClaudeAdviceResponse,
  ClaudeTrigger,
} from './claude.types.js';

const SCHEDULED_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const STALE_ORDERS_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours between stale_orders requests
const RECENT_ADVICE_SKIP_MS = 30 * 60 * 1000; // skip if any advice was sent <30 min ago
const MODEL = 'claude-sonnet-4-20250514';

@Injectable()
export class ClaudeService {
  private readonly logger = new Logger(ClaudeService.name);
  private client: Anthropic | null = null;
  private lastRegime: string | null = null;
  private lastAdviceAt = 0;
  private lastStaleOrdersAdviceAt = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly exchange: ExchangeService,
    private readonly grid: GridService,
    private readonly risk: RiskService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    const apiKey = this.config.get<string>('claude.apiKey');
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
      this.logger.log('Claude client initialized');
    } else {
      this.logger.warn('CLAUDE_API_KEY not set, Claude advisor disabled');
    }
  }

  // --- Scheduled call every 4 hours ---

  @Interval(SCHEDULED_INTERVAL_MS)
  async scheduledCheck(): Promise<void> {
    if (!this.client || !this.grid.isActive()) return;
    await this.requestAdvice('scheduled_4h');
  }

  // --- Trigger-based calls (via events) ---

  @OnEvent(BOT_EVENTS.PRICE_OUT_OF_RANGE)
  async onPriceOutOfRange(): Promise<void> {
    if (Date.now() - this.lastAdviceAt < RECENT_ADVICE_SKIP_MS) {
      this.logger.debug(
        'Skipping price_out_of_range advice: recent advice sent <30min ago',
      );
      return;
    }
    await this.requestAdvice('price_out_of_range');
  }

  @OnEvent(BOT_EVENTS.RISK_WARNING)
  async onDrawdownWarning(): Promise<void> {
    if (Date.now() - this.lastAdviceAt < RECENT_ADVICE_SKIP_MS) {
      this.logger.debug(
        'Skipping drawdown_warning advice: recent advice sent <30min ago',
      );
      return;
    }
    await this.requestAdvice('drawdown_warning');
  }

  @OnEvent(BOT_EVENTS.REGIME_CHANGE)
  async onRegimeChange(payload: RegimeChangePayload): Promise<void> {
    this.lastRegime = payload.newRegime;
    if (Date.now() - this.lastAdviceAt < RECENT_ADVICE_SKIP_MS) {
      this.logger.debug(
        'Skipping regime_change advice: recent advice sent <30min ago',
      );
      return;
    }
    await this.requestAdvice('regime_change');
  }

  @OnEvent(BOT_EVENTS.STALE_ORDERS)
  async onStaleOrders(): Promise<void> {
    if (!this.client || !this.grid.isActive()) return;

    const now = Date.now();
    if (now - this.lastStaleOrdersAdviceAt < STALE_ORDERS_COOLDOWN_MS) {
      this.logger.debug('Skipping stale_orders advice: cooldown active');
      return;
    }
    if (now - this.lastAdviceAt < RECENT_ADVICE_SKIP_MS) {
      this.logger.debug(
        'Skipping stale_orders advice: recent advice sent <30min ago',
      );
      return;
    }

    this.lastStaleOrdersAdviceAt = now;
    await this.requestAdvice('stale_orders');
  }

  // --- Core advice flow ---

  async requestAdvice(
    trigger: ClaudeTrigger,
  ): Promise<ClaudeAdviceResponse | null> {
    if (!this.client) {
      this.logger.warn('Claude client not available');
      return null;
    }

    this.logger.log(`Requesting Claude advice, trigger: ${trigger}`);
    this.lastAdviceAt = Date.now();

    // 1. Build context snapshot
    const snapshot = await this.buildSnapshot();

    // 2. Call Claude API
    let rawResponse: string;
    try {
      rawResponse = await withRetry(() => this.callClaude(snapshot), {
        maxRetries: 2,
        delayMs: 3000,
        logger: this.logger,
        context: 'claude:api',
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`Claude API call failed: ${msg}`);
      return null;
    }

    // 3. Parse response
    const { parsed, error } = parseClaudeResponse(rawResponse);
    if (error || !parsed) {
      this.logger.error(`Claude response parse failed: ${error}`);
      // Save raw response anyway for debugging
      await this.saveAdvice(trigger, snapshot, rawResponse, null, false);
      return null;
    }

    // 4. Save to DB
    const adviceId = await this.saveAdvice(
      trigger,
      snapshot,
      rawResponse,
      parsed,
      false,
    );

    // 5. Apply advice logic
    await this.applyAdvice(parsed, trigger, adviceId, snapshot);

    return parsed;
  }

  private async callClaude(snapshot: MarketSnapshot): Promise<string> {
    const response = await this.client!.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(snapshot) }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('No text response from Claude');
    }
    return textBlock.text;
  }

  // --- Snapshot builder ---

  async buildSnapshot(): Promise<MarketSnapshot> {
    const grid = this.grid.getGrid();
    const pair = grid?.pair ?? 'BTC/USDT';

    // Fetch current price
    let currentPrice = 0;
    let priceChange24h = 0;
    let volume24h = 0;
    try {
      const ticker = await this.exchange.fetchTicker(pair);
      currentPrice = ticker.last ?? 0;
      const tickerAny = ticker as unknown as Record<string, number>;
      priceChange24h = tickerAny.percentage ?? 0;
      volume24h = tickerAny.quoteVolume ?? 0;
    } catch {
      this.logger.warn('Failed to fetch ticker for snapshot');
    }

    // Fetch balance
    let usdt = 0;
    let btc = 0;
    try {
      const balance = await this.exchange.fetchBalance();
      usdt = ccxtFreeUsedAssetTotal(balance, 'USDT', 'usdt');
      btc = ccxtFreeUsedAssetTotal(balance, 'BTC', 'btc');
    } catch {
      this.logger.warn('Failed to fetch balance for snapshot');
    }

    // Recent trades (last 24h)
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentTrades = await this.prisma.trade.findMany({
      where: { pair, executedAt: { gte: dayAgo } },
      orderBy: { executedAt: 'desc' },
      take: 20,
    });

    const totalPnl24h = recentTrades.reduce(
      (sum, t) => sum + Number(t.pnlUsdt ?? 0),
      0,
    );

    // Latest regime
    const latestRegime = await this.prisma.marketRegime.findFirst({
      where: { pair },
      orderBy: { detectedAt: 'desc' },
    });

    // Risk snapshot
    const riskSnapshot = this.risk.getCurrentRiskSnapshot();

    // Latest ML features
    let indicators = {
      rsi14: null as number | null,
      adx14: null as number | null,
      atrPct: null as number | null,
      macdHistogram: null as number | null,
    };
    if (latestRegime?.features) {
      const f = latestRegime.features as Record<string, number>;
      indicators = {
        rsi14: f.rsi14 ?? null,
        adx14: f.adx14 ?? null,
        atrPct: f.atrPct ?? null,
        macdHistogram: f.macdHistogram ?? null,
      };
    }

    return {
      pair,
      currentPrice,
      priceChange24h,
      volume24h,
      regime: latestRegime?.regime ?? 'unknown',
      regimeConfidence: Number(latestRegime?.confidence ?? 0),
      gridActive: grid?.active ?? false,
      gridBounds: grid
        ? { lower: grid.lowerBound, upper: grid.upperBound }
        : null,
      gridStepPct: grid?.gridStepPct ?? null,
      balance: { usdt, btc },
      recentTrades: recentTrades.map((t) => ({
        side: t.side,
        price: Number(t.price),
        pnl: t.pnlUsdt ? Number(t.pnlUsdt) : null,
        time: t.executedAt.toISOString(),
      })),
      totalPnl24h,
      dailyDrawdownPct: riskSnapshot.dailyDrawdownPct,
      weeklyDrawdownPct: riskSnapshot.weeklyDrawdownPct,
      riskLevel: riskSnapshot.level,
      indicators,
    };
  }

  // --- Save advice to DB ---

  private async saveAdvice(
    trigger: ClaudeTrigger,
    snapshot: MarketSnapshot,
    rawResponse: string,
    parsed: ClaudeAdviceResponse | null,
    applied: boolean,
  ): Promise<bigint | null> {
    try {
      const record = await this.prisma.claudeAdvice.create({
        data: {
          createdAt: new Date(),
          triggerReason: trigger,
          contextSnapshot: JSON.parse(
            JSON.stringify(snapshot),
          ) as Prisma.InputJsonValue,
          rawResponse,
          parsedAdvice: parsed
            ? (JSON.parse(JSON.stringify(parsed)) as Prisma.InputJsonValue)
            : undefined,
          applied,
        },
      });
      return record.id;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`Failed to save Claude advice: ${msg}`);
      return null;
    }
  }

  // --- Apply advice logic ---

  // Fix 1.2: per-action auto-apply thresholds. Previously the bar was 0.8 for KEEP
  // and effectively unreachable for adjust/restart (any risk_flag → pending). Result:
  // most advice sat in pending_confirmation forever and the grid went stale.
  private static readonly AUTO_APPLY_THRESHOLD: Record<
    ClaudeAdviceResponse['grid_recommendation']['action'],
    number
  > = {
    pause: 0.5, // bias to safety
    keep: 0.6,
    adjust: 0.65,
    restart: 0.8, // most destructive — keep stricter
  };

  // Risk flags that mean "act now" — these LOWER the bar (don't block it).
  private static readonly CRITICAL_RISK_FLAGS = new Set([
    'price_outside_grid',
    'price_below_grid_bounds',
    'price_above_grid',
    'stop_loss_triggered',
  ]);

  /**
   * Fix 2.1: detect "chasing the falling knife".
   * Returns true if Claude wants to move the grid DOWN (lower_bound below current
   * grid lower) while the market is trending DOWN. In that case the right move is
   * to HOLD existing position, not to follow the price down.
   *
   * Downtrend qualifiers (any one is sufficient):
   *  - regime classifier says 'downtrend' with confidence >= 0.5
   *  - ADX > 25 AND current price has fallen below the existing grid lower bound
   *  - RSI14 < 35 (oversold, no bottom-confirmation signal)
   *
   * The proposal qualifies as "chasing" if it's an adjust/restart that lowers
   * the lower_bound vs the currently active grid by more than 0.5%.
   */
  private isDowntrendChase(
    advice: ClaudeAdviceResponse,
    snapshot: MarketSnapshot,
  ): boolean {
    const rec = advice.grid_recommendation;
    if (rec.action !== 'adjust' && rec.action !== 'restart') return false;
    if (rec.lower_bound == null) return false;
    if (!snapshot.gridBounds) return false;

    const currentLower = snapshot.gridBounds.lower;
    const proposedLower = rec.lower_bound;
    const lowerDropPct = ((currentLower - proposedLower) / currentLower) * 100;
    // Only block if the lower bound moves DOWN by >0.5%. Smaller noise is fine.
    if (lowerDropPct < 0.5) return false;

    const regimeIsDown =
      snapshot.regime === 'downtrend' && snapshot.regimeConfidence >= 0.5;

    const adx = snapshot.indicators.adx14 ?? 0;
    const rsi = snapshot.indicators.rsi14 ?? 50;
    const priceBelowGrid = snapshot.currentPrice < currentLower;
    const trendingDownByAdx = adx > 25 && priceBelowGrid;
    const oversold = rsi < 35;

    return regimeIsDown || trendingDownByAdx || oversold;
  }

  private async applyAdvice(
    advice: ClaudeAdviceResponse,
    trigger: ClaudeTrigger,
    adviceId: bigint | null,
    snapshot: MarketSnapshot,
  ): Promise<void> {
    const { action } = advice.grid_recommendation;
    const { confidence, risk_flags } = advice;

    // Fix 2.1: never let Claude chase price down in a downtrend.
    // If the recommendation lowers the lower_bound while the market is trending
    // down, force a PAUSE instead — we hold position rather than catch falling knives.
    if (this.isDowntrendChase(advice, snapshot)) {
      this.logger.warn(
        `Claude advice REWRITTEN to PAUSE: downtrend chase blocked. ` +
          `regime=${snapshot.regime}/${snapshot.regimeConfidence}, ` +
          `proposed lower=${advice.grid_recommendation.lower_bound}, ` +
          `current lower=${snapshot.gridBounds?.lower}, price=${snapshot.currentPrice}`,
      );
      await this.grid.cancelGrid();
      await this.markApplied(trigger);
      await this.logDecision(trigger, 'pause:downtrend_chase_blocked', advice);
      return;
    }

    // action "pause" → execute immediately regardless of confidence
    if (action === 'pause') {
      this.logger.warn(
        `Claude recommends PAUSE: ${advice.grid_recommendation.reason}`,
      );
      await this.grid.cancelGrid();
      await this.markApplied(trigger);
      await this.logDecision(trigger, action, advice);
      return;
    }

    const hasCriticalFlag = risk_flags.some((f) =>
      ClaudeService.CRITICAL_RISK_FLAGS.has(f),
    );
    const baseThreshold = ClaudeService.AUTO_APPLY_THRESHOLD[action];
    // Critical flags lower the bar to 0.6 (still need reasonable confidence).
    const effectiveThreshold = hasCriticalFlag
      ? Math.min(baseThreshold, 0.6)
      : baseThreshold;

    if (confidence >= effectiveThreshold) {
      this.logger.log(
        `Claude AUTO-APPLY ${action.toUpperCase()} (confidence=${confidence}, threshold=${effectiveThreshold}` +
          `${hasCriticalFlag ? ', critical-flag' : ''}): ${advice.grid_recommendation.reason}`,
      );
      if (action === 'keep') {
        await this.markApplied(trigger);
      } else {
        // adjust or restart → execute via shared helper
        await this.executeAdjustOrRestart(advice, action);
        await this.markApplied(trigger);
      }
      await this.logDecision(trigger, action, advice);
      return;
    }

    // Below threshold → send to Telegram for manual confirmation
    this.logger.log(
      `Claude advice pending confirmation: action=${action}, confidence=${confidence} ` +
        `< threshold=${effectiveThreshold}, risks=[${risk_flags.join(', ')}]`,
    );
    if (adviceId) {
      this.eventEmitter.emit(BOT_EVENTS.CLAUDE_ADVICE_PENDING, {
        adviceId,
        assessment: advice.market_assessment,
        action,
        reason: advice.grid_recommendation.reason,
        confidence,
      });
    }
    await this.logDecision(trigger, `pending_confirmation:${action}`, advice);
  }

  /**
   * Execute an adjust or restart action: cancel current grid and emit BOT_RESUMED
   * with suggested params (or fall back to ATR-based defaults).
   * Shared between auto-apply (applyAdvice) and manual Telegram apply (applyPendingAdvice).
   */
  private async executeAdjustOrRestart(
    advice: ClaudeAdviceResponse,
    action: 'adjust' | 'restart',
  ): Promise<void> {
    const rec = advice.grid_recommendation;
    await this.grid.cancelGrid();

    const payload: BotResumedPayload = { source: 'claude_advice' };
    if (
      rec.lower_bound != null &&
      rec.upper_bound != null &&
      rec.grid_step_pct != null
    ) {
      this.logger.log(
        `Applying Claude ${action} with params: [${rec.lower_bound} - ${rec.upper_bound}] step=${rec.grid_step_pct}%`,
      );
      payload.suggestedParams = {
        lowerBound: rec.lower_bound,
        upperBound: rec.upper_bound,
        gridStepPct: rec.grid_step_pct,
      };
    } else {
      this.logger.log(
        `Applying Claude ${action}: restarting with ATR-based params`,
      );
    }

    this.eventEmitter.emit(BOT_EVENTS.BOT_RESUMED, payload);
  }

  private async markApplied(trigger: ClaudeTrigger): Promise<void> {
    try {
      // Mark the latest advice for this trigger as applied
      const latest = await this.prisma.claudeAdvice.findFirst({
        where: { triggerReason: trigger },
        orderBy: { createdAt: 'desc' },
      });
      if (latest) {
        await this.prisma.claudeAdvice.update({
          where: { id: latest.id },
          data: { applied: true, appliedAt: new Date() },
        });
      }
    } catch {
      // non-critical
    }
  }

  private async logDecision(
    trigger: ClaudeTrigger,
    action: string,
    advice: ClaudeAdviceResponse,
  ): Promise<void> {
    try {
      await this.prisma.decisionLog.create({
        data: {
          decidedAt: new Date(),
          trigger: `claude:${trigger}`,
          actionTaken: {
            action,
            assessment: advice.market_assessment,
            recommendation: advice.grid_recommendation,
            confidence: advice.confidence,
            riskFlags: advice.risk_flags,
          },
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`Failed to log Claude decision: ${msg}`);
    }
  }

  // --- Public API for Telegram (Stage 8) ---

  async getLatestAdvice(): Promise<{
    advice: ClaudeAdviceResponse;
    trigger: string;
  } | null> {
    const latest = await this.prisma.claudeAdvice.findFirst({
      orderBy: { createdAt: 'desc' },
    });
    if (!latest?.parsedAdvice) return null;
    return {
      advice: latest.parsedAdvice as unknown as ClaudeAdviceResponse,
      trigger: latest.triggerReason ?? 'unknown',
    };
  }

  async applyPendingAdvice(adviceId: bigint): Promise<boolean> {
    const record = await this.prisma.claudeAdvice.findUnique({
      where: { id: adviceId },
    });
    if (!record?.parsedAdvice || record.applied) return false;

    const advice = record.parsedAdvice as unknown as ClaudeAdviceResponse;
    const { action } = advice.grid_recommendation;

    if (action === 'pause') {
      await this.grid.cancelGrid();
    }

    if (action === 'adjust' || action === 'restart') {
      await this.executeAdjustOrRestart(advice, action);
    }

    await this.prisma.claudeAdvice.update({
      where: { id: adviceId },
      data: { applied: true, appliedAt: new Date() },
    });

    return true;
  }
}
