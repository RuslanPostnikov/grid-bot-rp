import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { ExchangeService } from './modules/exchange/exchange.service.js';
import { GridService } from './modules/grid/grid.service.js';
import { RiskService } from './modules/risk/risk.service.js';
import { MlService } from './modules/ml/ml.service.js';
import { withRetry } from './common/retry.js';
import { checkRebalanceTriggers } from './modules/grid/grid-calculator.js';
import { ATR } from 'technicalindicators';

const ATR_PERIOD = 14;
const MIN_CANDLES = ATR_PERIOD + 1;

const REGIME_CHECK_MS = 60 * 60 * 1000; // 1 hour
const REBALANCE_CHECK_MS = 30 * 60 * 1000; // 30 min
const REBALANCE_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours

@Injectable()
export class BotOrchestratorService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BotOrchestratorService.name);
  private readonly pair: string;

  private lastRebalanceAt = 0;
  private upperZoneEnteredAt = 0;
  private lowerZoneEnteredAt = 0;

  constructor(
    private readonly exchange: ExchangeService,
    private readonly grid: GridService,
    private readonly risk: RiskService,
    private readonly ml: MlService,
    private readonly config: ConfigService,
  ) {
    this.pair = this.config.get<string>('exchange.tradingPair') ?? 'BTC/USDT';
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.grid.isActive()) {
      const currentGrid = this.grid.getGrid();
      if (currentGrid && currentGrid.orders.length === 0) {
        this.logger.log(
          'Grid active but 0 orders — cancelling and re-setting up...',
        );
        await this.grid.cancelGrid();
      } else {
        this.logger.log('Grid already active, skipping auto-setup');
        return;
      }
    }

    this.logger.log('No active grid found, starting auto-setup...');
    await this.autoSetupWithRetry();
  }

  // ─── Regime classification (every 1h) ─────────────────

  @Interval(REGIME_CHECK_MS)
  async checkMarketRegime(): Promise<void> {
    if (this.risk.isPaused()) return;

    try {
      const result = await this.ml.classifyCurrentRegime(this.pair);
      if (!result) {
        this.logger.debug('Not enough data for regime classification');
        return;
      }

      const { classification, action } = result;
      this.logger.log(
        `Market regime: ${classification.regime} (${(classification.confidence * 100).toFixed(0)}%) → ${action}`,
      );

      await this.handleRegimeAction(action);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`Regime classification failed: ${msg}`);
    }
  }

  private async handleRegimeAction(action: string): Promise<void> {
    switch (action) {
      case 'RUN_GRID':
        if (!this.grid.isActive()) {
          this.logger.log('Regime=FLAT → restarting grid');
          await this.autoSetupGrid();
        }
        break;

      case 'SHIFT_UP':
        if (this.grid.isActive()) {
          await this.triggerRebalance('regime:SHIFT_UP (uptrend)');
        }
        break;

      case 'WIDEN_GRID':
        if (this.grid.isActive()) {
          await this.triggerRebalance('regime:WIDEN_GRID (volatile)');
        }
        break;

      case 'PAUSE':
        if (this.grid.isActive()) {
          this.logger.log('Regime=DOWNTREND → cancelling grid');
          await this.grid.cancelGrid();
        }
        break;
    }
  }

  // ─── Rebalance triggers (every 30 min) ────────────────

  @Interval(REBALANCE_CHECK_MS)
  async checkRebalanceTriggers(): Promise<void> {
    if (!this.grid.isActive() || this.risk.isPaused()) return;

    const grid = this.grid.getGrid();
    if (!grid) return;

    const currentPrice = this.risk.getLastKnownPrice();
    if (currentPrice <= 0) return;

    // Track time in upper/lower zones
    const range = grid.upperBound - grid.lowerBound;
    const upperZoneThreshold = grid.upperBound - range * 0.2;
    const lowerZoneThreshold = grid.lowerBound + range * 0.2;
    const now = Date.now();

    if (currentPrice > upperZoneThreshold) {
      if (this.upperZoneEnteredAt === 0) this.upperZoneEnteredAt = now;
    } else {
      this.upperZoneEnteredAt = 0;
    }

    if (currentPrice < lowerZoneThreshold) {
      if (this.lowerZoneEnteredAt === 0) this.lowerZoneEnteredAt = now;
    } else {
      this.lowerZoneEnteredAt = 0;
    }

    const hoursInUpperZone =
      this.upperZoneEnteredAt > 0
        ? (now - this.upperZoneEnteredAt) / (60 * 60 * 1000)
        : 0;
    const hoursInLowerZone =
      this.lowerZoneEnteredAt > 0
        ? (now - this.lowerZoneEnteredAt) / (60 * 60 * 1000)
        : 0;

    // Fetch ATR data for trigger evaluation
    let atrPct: number;
    let avgAtrPct: number;
    try {
      const atrData = await this.fetchAtrData();
      atrPct = (atrData.atr14 / currentPrice) * 100;
      avgAtrPct = atrData.avgAtrPct;
    } catch {
      return;
    }

    const trigger = checkRebalanceTriggers(
      currentPrice,
      grid.lowerBound,
      grid.upperBound,
      atrPct,
      avgAtrPct,
      hoursInUpperZone,
      hoursInLowerZone,
    );

    if (trigger) {
      this.logger.log(`Rebalance trigger: ${trigger}`);
      await this.triggerRebalance(`trigger:${trigger}`);
    }
  }

  // ─── Rebalance helper ─────────────────────────────────

  private async triggerRebalance(reason: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastRebalanceAt < REBALANCE_COOLDOWN_MS) {
      this.logger.debug(
        `Rebalance cooldown active, skipping (reason: ${reason})`,
      );
      return;
    }

    try {
      const { currentPrice, atr14 } = await this.fetchMarketData();
      const activeCapital = this.risk.getActiveCapital();

      await this.grid.rebalanceGrid(
        currentPrice,
        atr14,
        activeCapital,
        reason,
      );
      this.lastRebalanceAt = Date.now();
      this.upperZoneEnteredAt = 0;
      this.lowerZoneEnteredAt = 0;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`Rebalance failed (${reason}): ${msg}`);
    }
  }

  // ─── Auto-setup ───────────────────────────────────────

  private async autoSetupWithRetry(): Promise<void> {
    const maxAttempts = 10;
    const delayMs = 10_000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.autoSetupGrid();
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt < maxAttempts) {
          this.logger.warn(
            `Auto-setup attempt ${attempt}/${maxAttempts} failed: ${msg}. Retrying in ${delayMs / 1000}s...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        } else {
          this.logger.error(
            `Auto-setup failed after ${maxAttempts} attempts: ${msg}`,
          );
        }
      }
    }
  }

  private async autoSetupGrid(): Promise<void> {
    const { currentPrice, atr14 } = await this.fetchMarketData();

    const balance = await withRetry(() => this.exchange.fetchBalance(), {
      maxRetries: 3,
      delayMs: 2000,
      logger: this.logger,
      context: 'autoSetup:balance',
    });
    const totalUsdt =
      Number(balance.free?.USDT ?? balance.free?.usdt ?? 0) +
      Number(balance.used?.USDT ?? balance.used?.usdt ?? 0);
    if (totalUsdt <= 0)
      throw new Error(`No USDT balance available: $${totalUsdt}`);

    const activeCapitalPct =
      this.config.get<number>('risk.activeCapitalPct') ?? 90;
    const activeCapital = totalUsdt * (activeCapitalPct / 100);

    this.logger.log(
      `Auto-setup: price=$${currentPrice.toFixed(2)}, ATR14=$${atr14.toFixed(2)}, capital=$${activeCapital.toFixed(2)}`,
    );

    await this.grid.setupGrid(this.pair, currentPrice, atr14, activeCapital);
    this.logger.log('Grid auto-setup complete');
  }

  // ─── Data helpers ─────────────────────────────────────

  private async fetchMarketData(): Promise<{
    currentPrice: number;
    atr14: number;
  }> {
    const ticker = await withRetry(
      () => this.exchange.fetchTicker(this.pair),
      {
        maxRetries: 3,
        delayMs: 2000,
        logger: this.logger,
        context: 'fetchMarketData:ticker',
      },
    );
    const currentPrice = ticker.last;
    if (!currentPrice) throw new Error('Cannot get current price');

    const atrData = await this.fetchAtrData();
    return { currentPrice, atr14: atrData.atr14 };
  }

  private async fetchAtrData(): Promise<{
    atr14: number;
    avgAtrPct: number;
  }> {
    const candles = await withRetry(
      () => this.exchange.fetchOHLCV(this.pair, '1h', undefined, 100),
      {
        maxRetries: 3,
        delayMs: 2000,
        logger: this.logger,
        context: 'fetchAtrData:ohlcv',
      },
    );

    if (candles.length < MIN_CANDLES) {
      throw new Error(
        `Not enough candles for ATR: ${candles.length} < ${MIN_CANDLES}`,
      );
    }

    const highs = candles.map((c) => c[2]);
    const lows = candles.map((c) => c[3]);
    const closes = candles.map((c) => c[4]);

    const atrValues = ATR.calculate({
      high: highs,
      low: lows,
      close: closes,
      period: ATR_PERIOD,
    });

    const atr14 = atrValues[atrValues.length - 1];
    if (!atr14) throw new Error('ATR calculation failed');

    // Average ATR% over last 20 values for comparison
    const lastPrice = closes[closes.length - 1];
    const recentAtrs = atrValues.slice(-20);
    const avgAtrPct =
      recentAtrs.reduce((s, v) => s + (v / lastPrice) * 100, 0) /
      recentAtrs.length;

    return { atr14, avgAtrPct };
  }
}
