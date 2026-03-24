import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { ExchangeService } from '../exchange/exchange.service.js';
import { GridService } from '../grid/grid.service.js';
import { PrismaService } from '../../prisma.service.js';
import { withRetry } from '../../common/retry.js';
import { BOT_EVENTS } from '../../common/events.js';
import {
  calculatePositionSizing,
  calculateDrawdownPct,
  calculatePriceDeviation,
  evaluateRisk,
} from './risk-calculator.js';
import {
  DEFAULT_RISK_CONFIG,
  type RiskConfig,
  type RiskCheckResult,
  type PositionSizing,
} from './risk.types.js';

const RISK_CHECK_INTERVAL_MS = 30_000; // every 30s
const BALANCE_SNAPSHOT_INTERVAL_MS = 60_000; // every 60s
const AUTO_RESUME_COOLDOWN_MS = 5 * 60 * 1000; // 5 min between auto-resumes

@Injectable()
export class RiskService implements OnModuleInit {
  private readonly logger = new Logger(RiskService.name);
  private readonly config: RiskConfig;

  private readonly baseAsset: string; // e.g. 'SOL', 'ETH' — derived from trading pair

  private initialCapital = 0;
  private dailyPeakBalance = 0;
  private weeklyPeakBalance = 0;
  private currentBalance = 0;
  private freeUsdt = 0;
  private usedUsdt = 0;
  private freeBase = 0;
  private usedBase = 0;
  private lastKnownPrice = 0;
  private lastDayReset = 0;
  private lastWeekReset = 0;
  private paused = false;
  private manualPause = false; // true = user did /pause, only /resume can lift it
  private lastAutoResumeAt = 0; // cooldown to prevent pause→resume→pause loop

  constructor(
    private readonly exchange: ExchangeService,
    private readonly grid: GridService,
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
  ) {
    const tradingPair =
      this.configService.get<string>('exchange.tradingPair') ?? 'BTC/USDT';
    this.baseAsset = tradingPair.split('/')[0]; // 'SOL/USDT' → 'SOL'

    this.config = {
      ...DEFAULT_RISK_CONFIG,
      activeCapitalPct:
        this.configService.get<number>('risk.activeCapitalPct') ??
        DEFAULT_RISK_CONFIG.activeCapitalPct,
      reserveCapitalPct:
        this.configService.get<number>('risk.reserveCapitalPct') ??
        DEFAULT_RISK_CONFIG.reserveCapitalPct,
      minBufferPct:
        this.configService.get<number>('risk.minBufferPct') ??
        DEFAULT_RISK_CONFIG.minBufferPct,
      maxPriceDeviationPct:
        this.configService.get<number>('risk.maxPriceDeviationPct') ??
        DEFAULT_RISK_CONFIG.maxPriceDeviationPct,
    };
    this.logger.log(
      `Risk config: active=${this.config.activeCapitalPct}%, reserve=${this.config.reserveCapitalPct}%, buffer=${this.config.minBufferPct}%`,
    );
  }

  async onModuleInit(): Promise<void> {
    await this.loadInitialBalance();
    this.resetDailyPeak();
    this.resetWeeklyPeak();
  }

  private async loadInitialBalance(): Promise<void> {
    try {
      // Fetch price first so crypto balance can be converted to USDT
      const grid = this.grid.getGrid();
      const pair = grid?.pair ?? `${this.baseAsset}/USDT`;
      try {
        const ticker = await this.exchange.fetchTicker(pair);
        this.lastKnownPrice = ticker.last ?? 0;
      } catch {
        this.logger.warn(
          'Could not fetch price for initial balance, crypto will show as $0',
        );
      }

      const balance = await withRetry(() => this.exchange.fetchBalance(), {
        maxRetries: 3,
        delayMs: 2000,
        logger: this.logger,
        context: 'risk:fetchBalance',
      });
      this.updateBalanceFromRaw(balance);
      this.initialCapital = this.currentBalance;
      this.dailyPeakBalance = this.currentBalance;
      this.weeklyPeakBalance = this.currentBalance;
      this.logger.log(
        `Initial balance loaded: $${this.currentBalance.toFixed(2)} (${this.baseAsset}: ${(this.freeBase + this.usedBase).toFixed(5)} @ $${this.lastKnownPrice.toFixed(2)})`,
      );
    } catch {
      this.logger.error('Failed to load initial balance for risk management');
    }
  }

  // --- Periodic balance snapshot ---

  @Interval(BALANCE_SNAPSHOT_INTERVAL_MS)
  async updateBalance(): Promise<void> {
    try {
      const balance = await withRetry(() => this.exchange.fetchBalance(), {
        maxRetries: 2,
        delayMs: 1000,
        logger: this.logger,
        context: 'risk:updateBalance',
      });
      this.updateBalanceFromRaw(balance);

      if (this.currentBalance > this.dailyPeakBalance)
        this.dailyPeakBalance = this.currentBalance;
      if (this.currentBalance > this.weeklyPeakBalance)
        this.weeklyPeakBalance = this.currentBalance;
    } catch {
      // skip, will retry next cycle
    }

    this.checkPeakResets();
  }

  private updateBalanceFromRaw(balance: {
    free: Record<string, number>;
    used: Record<string, number>;
  }): void {
    const asset = this.baseAsset;
    const assetLower = asset.toLowerCase();

    this.freeUsdt = Number(balance.free?.USDT ?? balance.free?.usdt ?? 0);
    this.usedUsdt = Number(balance.used?.USDT ?? balance.used?.usdt ?? 0);
    this.freeBase = Number(
      balance.free?.[asset] ?? balance.free?.[assetLower] ?? 0,
    );
    this.usedBase = Number(
      balance.used?.[asset] ?? balance.used?.[assetLower] ?? 0,
    );

    // Total balance = USDT + crypto converted to USDT
    const usdtTotal = this.freeUsdt + this.usedUsdt;
    const baseTotal = this.freeBase + this.usedBase;
    const baseInUsdt = baseTotal * this.lastKnownPrice;
    this.currentBalance = usdtTotal + baseInUsdt;
  }

  private checkPeakResets(): void {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const weekMs = 7 * dayMs;

    if (now - this.lastDayReset >= dayMs) {
      this.resetDailyPeak();
    }
    if (now - this.lastWeekReset >= weekMs) {
      this.resetWeeklyPeak();
    }
  }

  private resetDailyPeak(): void {
    this.dailyPeakBalance = this.currentBalance || this.initialCapital;
    this.lastDayReset = Date.now();
  }

  private resetWeeklyPeak(): void {
    this.weeklyPeakBalance = this.currentBalance || this.initialCapital;
    this.lastWeekReset = Date.now();
  }

  // --- Risk check (every 30s) ---

  @Interval(RISK_CHECK_INTERVAL_MS)
  async checkRisk(): Promise<void> {
    // When paused by auto-risk, keep checking so we can auto-recover
    // When paused manually or grid not active and not paused — skip
    if (!this.grid.isActive() && !this.paused) return;
    if (this.manualPause) return; // manual pause — only /resume can lift

    const grid = this.grid.getGrid();
    const pair = grid?.pair ?? `${this.baseAsset}/USDT`;

    // Get current price
    let currentPrice: number;
    try {
      const ticker = await withRetry(() => this.exchange.fetchTicker(pair), {
        maxRetries: 2,
        delayMs: 1000,
        logger: this.logger,
        context: 'risk:fetchTicker',
      });
      currentPrice = ticker.last ?? 0;
      this.lastKnownPrice = currentPrice;
    } catch {
      return; // retry next cycle
    }

    const dailyDD = calculateDrawdownPct(
      this.dailyPeakBalance,
      this.currentBalance,
    );
    const weeklyDD = calculateDrawdownPct(
      this.weeklyPeakBalance,
      this.currentBalance,
    );
    const priceDev = grid
      ? calculatePriceDeviation(currentPrice, grid.lowerBound, grid.upperBound)
      : 0;

    if (priceDev >= this.config.maxPriceDeviationPct) {
      this.eventEmitter.emit(BOT_EVENTS.PRICE_OUT_OF_RANGE, {
        priceDeviationPct: priceDev,
        currentPrice,
        lowerBound: grid?.lowerBound ?? 0,
        upperBound: grid?.upperBound ?? 0,
      });
    }

    const result = evaluateRisk(
      dailyDD,
      weeklyDD,
      priceDev,
      this.currentBalance,
      this.initialCapital,
      this.config,
    );

    await this.handleRiskResult(result);
  }

  private async handleRiskResult(result: RiskCheckResult): Promise<void> {
    if (result.level === 'normal') {
      if (this.paused && !this.manualPause) {
        const now = Date.now();
        if (now - this.lastAutoResumeAt < AUTO_RESUME_COOLDOWN_MS) {
          this.logger.log(
            'Risk normal but auto-resume cooldown active, skipping',
          );
          return;
        }
        this.logger.log('Risk back to normal — auto-resuming grid');
        this.paused = false;
        this.lastAutoResumeAt = now;
        this.resetDailyPeak();
        this.eventEmitter.emit(BOT_EVENTS.BOT_RESUMED);
        await this.logDecision('risk_auto_resume', result);
      }
      return;
    }

    if (result.level === 'warning') {
      this.logger.warn(`RISK WARNING: ${result.reasons.join('; ')}`);
      this.eventEmitter.emit(BOT_EVENTS.RISK_WARNING, {
        level: result.level,
        reasons: result.reasons,
        dailyDrawdownPct: result.dailyDrawdownPct,
        weeklyDrawdownPct: result.weeklyDrawdownPct,
      });
      await this.logDecision('risk_warning', result);
      return;
    }

    if (result.level === 'pause' && !this.paused) {
      this.logger.error(`RISK PAUSE: ${result.reasons.join('; ')}`);
      this.paused = true;
      await this.grid.cancelGrid();
      this.eventEmitter.emit(BOT_EVENTS.RISK_PAUSE, {
        level: result.level,
        reasons: result.reasons,
        dailyDrawdownPct: result.dailyDrawdownPct,
        weeklyDrawdownPct: result.weeklyDrawdownPct,
      });
      await this.logDecision('risk_pause', result);
      return;
    }

    if (result.level === 'stop') {
      this.logger.error(`RISK STOP: ${result.reasons.join('; ')}`);
      this.paused = true;
      await this.grid.cancelGrid();
      await this.logDecision('risk_stop', result);
    }
  }

  private async logDecision(
    trigger: string,
    result: RiskCheckResult,
  ): Promise<void> {
    try {
      await this.prisma.decisionLog.create({
        data: {
          decidedAt: new Date(),
          trigger,
          actionTaken: {
            level: result.level,
            reasons: result.reasons,
            dailyDD: result.dailyDrawdownPct,
            weeklyDD: result.weeklyDrawdownPct,
            priceDev: result.priceDeviationPct,
            balance: result.currentBalance,
          },
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`Failed to log risk decision: ${msg}`);
    }
  }

  // --- Position sizing ---

  getPositionSizing(): PositionSizing {
    return calculatePositionSizing(this.initialCapital, this.config);
  }

  getActiveCapital(): number {
    return this.getPositionSizing().activeCapital;
  }

  getBalanceSnapshot() {
    return {
      freeUsdt: this.freeUsdt,
      usedUsdt: this.usedUsdt,
      totalUsdt: this.freeUsdt + this.usedUsdt,
      freeBase: this.freeBase,
      usedBase: this.usedBase,
      totalBase: this.freeBase + this.usedBase,
      baseAsset: this.baseAsset,
      price: this.lastKnownPrice,
    };
  }

  getLastKnownPrice(): number {
    return this.lastKnownPrice;
  }

  // --- State queries ---

  isPaused(): boolean {
    return this.paused;
  }

  pause(): void {
    this.paused = true;
    this.manualPause = true;
    this.logger.log('Manual pause activated');
  }

  resume(): void {
    this.paused = false;
    this.manualPause = false;
    this.resetDailyPeak();
    this.logger.log('Pause lifted, grid can be resumed');
  }

  getCurrentRiskSnapshot(): RiskCheckResult {
    const grid = this.grid.getGrid();
    const dailyDD = calculateDrawdownPct(
      this.dailyPeakBalance,
      this.currentBalance,
    );
    const weeklyDD = calculateDrawdownPct(
      this.weeklyPeakBalance,
      this.currentBalance,
    );
    const priceDev = grid
      ? calculatePriceDeviation(
          this.lastKnownPrice,
          grid.lowerBound,
          grid.upperBound,
        )
      : 0;

    return evaluateRisk(
      dailyDD,
      weeklyDD,
      priceDev,
      this.currentBalance,
      this.initialCapital,
      this.config,
    );
  }
}
