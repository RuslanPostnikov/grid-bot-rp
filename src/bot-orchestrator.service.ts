import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ExchangeService } from './modules/exchange/exchange.service.js';
import { GridService } from './modules/grid/grid.service.js';
import { RiskService } from './modules/risk/risk.service.js';
import { withRetry } from './common/retry.js';
import { ATR } from 'technicalindicators';

const PAIR = 'BTC/USDT';
const ATR_PERIOD = 14;
const MIN_CANDLES = ATR_PERIOD + 1;

@Injectable()
export class BotOrchestratorService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BotOrchestratorService.name);

  constructor(
    private readonly exchange: ExchangeService,
    private readonly grid: GridService,
    private readonly risk: RiskService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.grid.isActive()) {
      this.logger.log('Grid already active, skipping auto-setup');
      return;
    }

    this.logger.log('No active grid found, starting auto-setup...');

    try {
      await this.autoSetupGrid();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`Auto-setup failed: ${msg}. Use manual setupGrid().`);
    }
  }

  private async autoSetupGrid(): Promise<void> {
    // 1. Get current price
    const ticker = await withRetry(
      () => this.exchange.fetchTicker(PAIR),
      { maxRetries: 3, delayMs: 2000, logger: this.logger, context: 'autoSetup:ticker' },
    );
    const currentPrice = ticker.last;
    if (!currentPrice) throw new Error('Cannot get current price');

    // 2. Calculate ATR from 1h candles
    const candles = await withRetry(
      () => this.exchange.fetchOHLCV(PAIR, '1h', undefined, 100),
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

    // 3. Get active capital from risk service
    const activeCapital = this.risk.getActiveCapital();
    if (activeCapital <= 0) throw new Error(`Invalid active capital: ${activeCapital}`);

    this.logger.log(
      `Auto-setup: price=$${currentPrice.toFixed(2)}, ATR14=$${atr14.toFixed(2)}, capital=$${activeCapital.toFixed(2)}`,
    );

    // 4. Setup grid
    await this.grid.setupGrid(PAIR, currentPrice, atr14, activeCapital);

    this.logger.log('Grid auto-setup complete');
  }
}
