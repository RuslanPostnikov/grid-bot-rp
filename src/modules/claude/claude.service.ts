import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import Anthropic from '@anthropic-ai/sdk';
import { BOT_EVENTS, type RegimeChangePayload, type RiskEventPayload } from '../../common/events.js';
import { PrismaService } from '../../prisma.service.js';
import { ExchangeService } from '../exchange/exchange.service.js';
import { GridService } from '../grid/grid.service.js';
import { RiskService } from '../risk/risk.service.js';
import { withRetry } from '../../common/retry.js';
import { SYSTEM_PROMPT, buildUserPrompt, parseClaudeResponse } from './claude-prompt.js';
import type { MarketSnapshot, ClaudeAdviceResponse, ClaudeTrigger } from './claude.types.js';

const SCHEDULED_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const MODEL = 'claude-sonnet-4-20250514';

@Injectable()
export class ClaudeService {
  private readonly logger = new Logger(ClaudeService.name);
  private client: Anthropic | null = null;
  private lastRegime: string | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly exchange: ExchangeService,
    private readonly grid: GridService,
    private readonly risk: RiskService,
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
    await this.requestAdvice('price_out_of_range');
  }

  @OnEvent(BOT_EVENTS.RISK_WARNING)
  async onDrawdownWarning(_payload: RiskEventPayload): Promise<void> {
    await this.requestAdvice('drawdown_warning');
  }

  @OnEvent(BOT_EVENTS.REGIME_CHANGE)
  async onRegimeChange(payload: RegimeChangePayload): Promise<void> {
    this.lastRegime = payload.newRegime;
    await this.requestAdvice('regime_change');
  }

  // --- Core advice flow ---

  async requestAdvice(trigger: ClaudeTrigger): Promise<ClaudeAdviceResponse | null> {
    if (!this.client) {
      this.logger.warn('Claude client not available');
      return null;
    }

    this.logger.log(`Requesting Claude advice, trigger: ${trigger}`);

    // 1. Build context snapshot
    const snapshot = await this.buildSnapshot();

    // 2. Call Claude API
    let rawResponse: string;
    try {
      rawResponse = await withRetry(
        () => this.callClaude(snapshot),
        { maxRetries: 2, delayMs: 3000, logger: this.logger, context: 'claude:api' },
      );
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
    await this.saveAdvice(trigger, snapshot, rawResponse, parsed, false);

    // 5. Apply advice logic
    await this.applyAdvice(parsed, trigger);

    return parsed;
  }

  private async callClaude(snapshot: MarketSnapshot): Promise<string> {
    const response = await this.client!.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: buildUserPrompt(snapshot) },
      ],
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
      usdt = Number(balance.free?.USDT ?? 0) + Number(balance.used?.USDT ?? 0);
      btc = Number(balance.free?.BTC ?? 0) + Number(balance.used?.BTC ?? 0);
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
    let indicators = { rsi14: null as number | null, adx14: null as number | null, atrPct: null as number | null, macdHistogram: null as number | null };
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
      gridBounds: grid ? { lower: grid.lowerBound, upper: grid.upperBound } : null,
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
  ): Promise<void> {
    try {
      await this.prisma.claudeAdvice.create({
        data: {
          createdAt: new Date(),
          triggerReason: trigger,
          contextSnapshot: JSON.parse(JSON.stringify(snapshot)),
          rawResponse,
          parsedAdvice: parsed ? JSON.parse(JSON.stringify(parsed)) : undefined,
          applied,
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`Failed to save Claude advice: ${msg}`);
    }
  }

  // --- Apply advice logic ---

  private async applyAdvice(
    advice: ClaudeAdviceResponse,
    trigger: ClaudeTrigger,
  ): Promise<void> {
    const { action } = advice.grid_recommendation;
    const { confidence, risk_flags } = advice;

    // action "pause" → execute immediately
    if (action === 'pause') {
      this.logger.warn(`Claude recommends PAUSE: ${advice.grid_recommendation.reason}`);
      await this.grid.cancelGrid();
      await this.markApplied(trigger);
      await this.logDecision(trigger, action, advice);
      return;
    }

    // High confidence "keep" → apply silently
    if (confidence > 0.8 && action === 'keep') {
      this.logger.log(`Claude confirms KEEP (confidence=${confidence}): ${advice.grid_recommendation.reason}`);
      await this.markApplied(trigger);
      await this.logDecision(trigger, action, advice);
      return;
    }

    // Low confidence or risk flags → log only, wait for Telegram confirmation (Stage 8)
    if (confidence < 0.7 || risk_flags.length > 0) {
      this.logger.warn(
        `Claude advice needs confirmation: action=${action}, confidence=${confidence}, risks=${risk_flags.join(', ')}`,
      );
      await this.logDecision(trigger, `pending_confirmation:${action}`, advice);
      return;
    }

    // Medium confidence adjust → log for Telegram confirmation (Stage 8)
    if (action === 'adjust') {
      this.logger.log(
        `Claude suggests ADJUST (confidence=${confidence}): ${advice.grid_recommendation.reason}`,
      );
      await this.logDecision(trigger, `pending_confirmation:${action}`, advice);
      return;
    }

    // Restart → log for confirmation
    if (action === 'restart') {
      this.logger.log(`Claude suggests RESTART: ${advice.grid_recommendation.reason}`);
      await this.logDecision(trigger, `pending_confirmation:${action}`, advice);
      return;
    }
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

  async getLatestAdvice(): Promise<{ advice: ClaudeAdviceResponse; trigger: string } | null> {
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
    const record = await this.prisma.claudeAdvice.findUnique({ where: { id: adviceId } });
    if (!record?.parsedAdvice || record.applied) return false;

    const advice = record.parsedAdvice as unknown as ClaudeAdviceResponse;
    const { action } = advice.grid_recommendation;

    if (action === 'pause') {
      await this.grid.cancelGrid();
    }
    // adjust/restart would need grid reconfiguration — handled in future stages

    await this.prisma.claudeAdvice.update({
      where: { id: adviceId },
      data: { applied: true, appliedAt: new Date() },
    });

    return true;
  }
}
