import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { ExchangeService } from './modules/exchange/exchange.service.js';
import { GridService } from './modules/grid/grid.service.js';
import { withRetry } from './common/retry.js';
import {
  BOT_EVENTS,
  type BotResumedPayload,
  type RegimeChangePayload,
} from './common/events.js';
import { calculateRebalance } from './modules/grid/grid-calculator.js';
import { ATR } from 'technicalindicators';

const ATR_PERIOD = 14;
const MIN_CANDLES = ATR_PERIOD + 1;
const REGIME_ACTION_COOLDOWN_MS = 30 * 60 * 1000; // 30 min

@Injectable()
export class BotOrchestratorService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BotOrchestratorService.name);
  private readonly pair: string;
  private lastRegimeActionAt = 0;

  constructor(
    private readonly exchange: ExchangeService,
    private readonly grid: GridService,
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

  private async autoSetupWithRetry(): Promise<void> {
    const maxAttempts = 10;
    const delayMs = 10_000; // 10s between attempts

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

  @OnEvent(BOT_EVENTS.BOT_RESUMED)
  async onBotResumed(payload?: BotResumedPayload): Promise<void> {
    if (this.grid.isActive()) {
      this.logger.log('Grid already active after resume, skipping setup');
      return;
    }

    if (payload?.suggestedParams) {
      this.logger.log('Bot resumed with suggested params, applying...');
      try {
        const { currentPrice, activeCapital } =
          await this.fetchPriceAndCapital();
        const { lowerBound, upperBound, gridStepPct } = payload.suggestedParams;
        await this.grid.setupGridWithParams(
          this.pair,
          currentPrice,
          activeCapital,
          lowerBound,
          upperBound,
          gridStepPct,
        );
        this.logger.log('Grid setup with suggested params complete');
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.warn(
          `Setup with suggested params failed: ${msg}, falling back to ATR`,
        );
      }
    }

    this.logger.log('Bot resumed, restarting grid...');
    await this.autoSetupWithRetry();
  }

  @OnEvent(BOT_EVENTS.REGIME_CHANGE)
  async onRegimeChange(payload: RegimeChangePayload): Promise<void> {
    const { action, confidence, newRegime } = payload;

    if (confidence < 0.6) {
      this.logger.log(
        `Regime ${newRegime} ignored (confidence ${confidence.toFixed(2)} < 0.6)`,
      );
      return;
    }

    const now = Date.now();
    if (now - this.lastRegimeActionAt < REGIME_ACTION_COOLDOWN_MS) {
      this.logger.log('Regime action cooldown active, skipping');
      return;
    }

    this.logger.log(
      `Regime change: ${payload.oldRegime} → ${newRegime}, action=${action}`,
    );

    try {
      switch (action) {
        case 'RUN_GRID':
          if (!this.grid.isActive()) {
            this.logger.log('Flat regime detected, starting grid...');
            this.lastRegimeActionAt = now;
            await this.autoSetupWithRetry();
          }
          break;

        case 'SHIFT_UP': {
          if (!this.grid.isActive()) break;
          this.logger.log('Uptrend detected, rebalancing grid...');
          this.lastRegimeActionAt = now;
          const atrData = await this.fetchAtrData();
          if (atrData) {
            const grid = this.grid.getGrid()!;
            const result = calculateRebalance(
              'price_upper_zone',
              atrData.currentPrice,
              atrData.atr14,
              grid.gridStepPct,
              atrData.avgAtrPct,
            );
            await this.grid.rebalanceGrid(atrData.currentPrice, result);
          }
          break;
        }

        case 'PAUSE':
          if (this.grid.isActive()) {
            this.logger.log('Downtrend detected, pausing grid...');
            this.lastRegimeActionAt = now;
            await this.grid.cancelGrid();
          }
          break;

        case 'WIDEN_GRID': {
          if (!this.grid.isActive()) break;
          this.logger.log('High volatility detected, widening grid...');
          this.lastRegimeActionAt = now;
          const atrData = await this.fetchAtrData();
          if (atrData) {
            const grid = this.grid.getGrid()!;
            const result = calculateRebalance(
              'atr_increase',
              atrData.currentPrice,
              atrData.atr14,
              grid.gridStepPct,
              atrData.avgAtrPct,
            );
            await this.grid.rebalanceGrid(atrData.currentPrice, result);
          }
          break;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`Regime action ${action} failed: ${msg}`);
    }
  }

  private async fetchPriceAndCapital(): Promise<{
    currentPrice: number;
    activeCapital: number;
  }> {
    const ticker = await withRetry(() => this.exchange.fetchTicker(this.pair), {
      maxRetries: 3,
      delayMs: 2000,
      logger: this.logger,
      context: 'fetchPriceAndCapital:ticker',
    });
    const currentPrice = ticker.last;
    if (!currentPrice) throw new Error('Cannot get current price');

    const balance = await withRetry(() => this.exchange.fetchBalance(), {
      maxRetries: 3,
      delayMs: 2000,
      logger: this.logger,
      context: 'fetchPriceAndCapital:balance',
    });
    const totalUsdt =
      Number(balance.free?.USDT ?? balance.free?.usdt ?? 0) +
      Number(balance.used?.USDT ?? balance.used?.usdt ?? 0);
    if (totalUsdt <= 0) throw new Error(`No USDT balance: $${totalUsdt}`);

    const activeCapitalPct =
      this.config.get<number>('risk.activeCapitalPct') ?? 90;
    return {
      currentPrice,
      activeCapital: totalUsdt * (activeCapitalPct / 100),
    };
  }

  private async fetchAtrData(): Promise<{
    currentPrice: number;
    atr14: number;
    avgAtrPct: number;
  } | null> {
    try {
      const ticker = await this.exchange.fetchTicker(this.pair);
      const currentPrice = ticker.last;
      if (!currentPrice) return null;

      const candles = await this.exchange.fetchOHLCV(
        this.pair,
        '1h',
        undefined,
        100,
      );
      if (candles.length < MIN_CANDLES) return null;

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
      if (!atr14) return null;

      const atrPctValues = atrValues.slice(-14).map((v, i) => {
        const idx = closes.length - 14 + i;
        return (v / closes[idx]) * 100;
      });
      const avgAtrPct =
        atrPctValues.reduce((s, v) => s + v, 0) / atrPctValues.length;

      return { currentPrice, atr14, avgAtrPct };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`Failed to fetch ATR data: ${msg}`);
      return null;
    }
  }

  private async autoSetupGrid(): Promise<void> {
    // 1. Get current price
    const ticker = await withRetry(() => this.exchange.fetchTicker(this.pair), {
      maxRetries: 3,
      delayMs: 2000,
      logger: this.logger,
      context: 'autoSetup:ticker',
    });
    const currentPrice = ticker.last;
    if (!currentPrice) throw new Error('Cannot get current price');

    // 2. Calculate ATR from 1h candles
    const candles = await withRetry(
      () => this.exchange.fetchOHLCV(this.pair, '1h', undefined, 100),
      {
        maxRetries: 3,
        delayMs: 2000,
        logger: this.logger,
        context: 'autoSetup:ohlcv',
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

    // 3. Get actual balance directly from exchange
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

    // 4. Setup grid
    await this.grid.setupGrid(this.pair, currentPrice, atr14, activeCapital);

    this.logger.log('Grid auto-setup complete');
  }
}
