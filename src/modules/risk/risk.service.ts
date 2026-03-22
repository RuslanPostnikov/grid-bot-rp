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

@Injectable()
export class RiskService implements OnModuleInit {
  private readonly logger = new Logger(RiskService.name);
  private readonly config: RiskConfig;

  private initialCapital = 0;
  private dailyPeakBalance = 0;
  private weeklyPeakBalance = 0;
  private currentBalance = 0;
  private lastDayReset = 0;
  private lastWeekReset = 0;
  private paused = false;

  constructor(
    private readonly exchange: ExchangeService,
    private readonly grid: GridService,
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
  ) {
    this.config = {
      ...DEFAULT_RISK_CONFIG,
      activeCapitalPct: this.configService.get<number>('risk.activeCapitalPct') ?? DEFAULT_RISK_CONFIG.activeCapitalPct,
      reserveCapitalPct: this.configService.get<number>('risk.reserveCapitalPct') ?? DEFAULT_RISK_CONFIG.reserveCapitalPct,
      minBufferPct: this.configService.get<number>('risk.minBufferPct') ?? DEFAULT_RISK_CONFIG.minBufferPct,
    };
    this.logger.log(`Risk config: active=${this.config.activeCapitalPct}%, reserve=${this.config.reserveCapitalPct}%, buffer=${this.config.minBufferPct}%`);
  }

  async onModuleInit(): Promise<void> {
    await this.loadInitialBalance();
    this.resetDailyPeak();
    this.resetWeeklyPeak();
  }

  private async loadInitialBalance(): Promise<void> {
    try {
      const balance = await withRetry(() => this.exchange.fetchBalance(), {
        maxRetries: 3,
        delayMs: 2000,
        logger: this.logger,
        context: 'risk:fetchBalance',
      });
      const usdt =
        Number(balance.free?.USDT ?? balance.free?.usdt ?? 0) +
        Number(balance.used?.USDT ?? balance.used?.usdt ?? 0);
      this.currentBalance = usdt;
      this.initialCapital = usdt;
      this.dailyPeakBalance = usdt;
      this.weeklyPeakBalance = usdt;
      this.logger.log(`Initial balance loaded: $${usdt.toFixed(2)}`);
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
      const usdt =
        Number(balance.free?.USDT ?? balance.free?.usdt ?? 0) +
        Number(balance.used?.USDT ?? balance.used?.usdt ?? 0);
      this.currentBalance = usdt;

      if (usdt > this.dailyPeakBalance) this.dailyPeakBalance = usdt;
      if (usdt > this.weeklyPeakBalance) this.weeklyPeakBalance = usdt;
    } catch {
      // skip, will retry next cycle
    }

    this.checkPeakResets();
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
    if (!this.grid.isActive()) return;

    const grid = this.grid.getGrid();
    if (!grid) return;

    // Get current price
    let currentPrice: number;
    try {
      const ticker = await withRetry(
        () => this.exchange.fetchTicker(grid.pair),
        {
          maxRetries: 2,
          delayMs: 1000,
          logger: this.logger,
          context: 'risk:fetchTicker',
        },
      );
      currentPrice = ticker.last ?? 0;
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
    const priceDev = calculatePriceDeviation(
      currentPrice,
      grid.lowerBound,
      grid.upperBound,
    );

    if (priceDev >= this.config.maxPriceDeviationPct) {
      this.eventEmitter.emit(BOT_EVENTS.PRICE_OUT_OF_RANGE, {
        priceDeviationPct: priceDev,
        currentPrice,
        lowerBound: grid.lowerBound,
        upperBound: grid.upperBound,
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
      if (this.paused) {
        this.logger.log(
          'Risk back to normal, but staying paused until manual resume',
        );
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

  // --- State queries ---

  isPaused(): boolean {
    return this.paused;
  }

  resume(): void {
    this.paused = false;
    this.resetDailyPeak();
    this.logger.log('Risk pause lifted, grid can be resumed');
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
      ? calculatePriceDeviation(0, grid.lowerBound, grid.upperBound)
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
