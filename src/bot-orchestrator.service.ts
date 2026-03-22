import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExchangeService } from './modules/exchange/exchange.service.js';
import { GridService } from './modules/grid/grid.service.js';
import { withRetry } from './common/retry.js';
import { ATR } from 'technicalindicators';

const ATR_PERIOD = 14;
const MIN_CANDLES = ATR_PERIOD + 1;

@Injectable()
export class BotOrchestratorService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BotOrchestratorService.name);

  private readonly pair: string;

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
        this.logger.log('Grid active but 0 orders — cancelling and re-setting up...');
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
          this.logger.warn(`Auto-setup attempt ${attempt}/${maxAttempts} failed: ${msg}. Retrying in ${delayMs / 1000}s...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        } else {
          this.logger.error(`Auto-setup failed after ${maxAttempts} attempts: ${msg}`);
        }
      }
    }
  }

  private async autoSetupGrid(): Promise<void> {
    // 1. Get current price
    const ticker = await withRetry(
      () => this.exchange.fetchTicker(this.pair),
      { maxRetries: 3, delayMs: 2000, logger: this.logger, context: 'autoSetup:ticker' },
    );
    const currentPrice = ticker.last;
    if (!currentPrice) throw new Error('Cannot get current price');

    // 2. Calculate ATR from 1h candles
    const candles = await withRetry(
      () => this.exchange.fetchOHLCV(this.pair, '1h', undefined, 100),
      { maxRetries: 3, delayMs: 2000, logger: this.logger, context: 'autoSetup:ohlcv' },
    );

    if (candles.length < MIN_CANDLES) {
      throw new Error(`Not enough candles for ATR: ${candles.length} < ${MIN_CANDLES}`);
    }

    const highs = candles.map(c => c[2] as number);
    const lows = candles.map(c => c[3] as number);
    const closes = candles.map(c => c[4] as number);

    const atrValues = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });
    const atr14 = atrValues[atrValues.length - 1];
    if (!atr14) throw new Error('ATR calculation failed');

    // 3. Get actual balance directly from exchange
    const balance = await withRetry(
      () => this.exchange.fetchBalance(),
      { maxRetries: 3, delayMs: 2000, logger: this.logger, context: 'autoSetup:balance' },
    );
    const totalUsdt = Number(balance.free?.USDT ?? balance.free?.usdt ?? 0)
      + Number(balance.used?.USDT ?? balance.used?.usdt ?? 0);
    if (totalUsdt <= 0) throw new Error(`No USDT balance available: $${totalUsdt}`);

    const activeCapitalPct = this.config.get<number>('risk.activeCapitalPct') ?? 90;
    const activeCapital = totalUsdt * (activeCapitalPct / 100);

    this.logger.log(
      `Auto-setup: price=$${currentPrice.toFixed(2)}, ATR14=$${atr14.toFixed(2)}, capital=$${activeCapital.toFixed(2)}`,
    );

    // 4. Setup grid
    await this.grid.setupGrid(this.pair, currentPrice, atr14, activeCapital);

    this.logger.log('Grid auto-setup complete');
  }
}
