import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ExchangeService } from '../exchange/exchange.service.js';
import { PrismaService } from '../../prisma.service.js';
import { withRetry } from '../../common/retry.js';
import type { OHLCV, OrderBook, Balances } from 'ccxt';

const TRADING_PAIR = 'BTC/USDT';
const TIMEFRAMES = ['1h', '4h'] as const;
const CANDLE_POLL_MS = 60_000; // 1 min
const ORDERBOOK_POLL_MS = 30_000; // 30 sec
const BALANCE_POLL_MS = 60_000; // 1 min

@Injectable()
export class CollectorService implements OnModuleInit {
  private readonly logger = new Logger(CollectorService.name);
  private latestOrderBook: OrderBook | null = null;
  private latestBalance: Balances | null = null;

  constructor(
    private readonly exchange: ExchangeService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    this.logger.log(`Collector started for ${TRADING_PAIR}`);
  }

  // --- OHLCV Candles ---

  @Interval(CANDLE_POLL_MS)
  async pollCandles(): Promise<void> {
    for (const timeframe of TIMEFRAMES) {
      try {
        await this.fetchAndStoreCandles(TRADING_PAIR, timeframe);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Failed to poll candles ${TRADING_PAIR} ${timeframe}: ${msg}`,
        );
      }
    }
  }

  private async fetchAndStoreCandles(
    pair: string,
    timeframe: string,
  ): Promise<void> {
    const candles = await withRetry(
      () => this.exchange.fetchOHLCV(pair, timeframe, undefined, 5),
      {
        maxRetries: 3,
        delayMs: 2000,
        logger: this.logger,
        context: `fetchOHLCV:${pair}:${timeframe}`,
      },
    );

    let stored = 0;
    for (const candle of candles) {
      const saved = await this.upsertCandle(pair, timeframe, candle);
      if (saved) stored++;
    }

    if (stored > 0) {
      this.logger.debug(
        `Stored ${stored} new candles for ${pair} ${timeframe}`,
      );
    }
  }

  private async upsertCandle(
    pair: string,
    timeframe: string,
    candle: OHLCV,
  ): Promise<boolean> {
    const [timestamp, open, high, low, close, volume] = candle;
    const openTime = new Date(timestamp);

    const existing = await this.prisma.candle.findUnique({
      where: {
        pair_timeframe_openTime: { pair, timeframe, openTime },
      },
    });

    if (existing) return false;

    await this.prisma.candle.create({
      data: {
        pair,
        timeframe,
        openTime,
        open,
        high,
        low,
        close,
        volume,
      },
    });

    return true;
  }

  // --- OrderBook ---

  @Interval(ORDERBOOK_POLL_MS)
  async pollOrderBook(): Promise<void> {
    try {
      this.latestOrderBook = await withRetry(
        () => this.exchange.fetchOrderBook(TRADING_PAIR, 10),
        {
          maxRetries: 3,
          delayMs: 2000,
          logger: this.logger,
          context: 'fetchOrderBook',
        },
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to poll orderbook: ${msg}`);
    }
  }

  getLatestOrderBook(): OrderBook | null {
    return this.latestOrderBook;
  }

  // --- Balance & Positions ---

  @Interval(BALANCE_POLL_MS)
  async pollBalance(): Promise<void> {
    try {
      this.latestBalance = await withRetry(() => this.exchange.fetchBalance(), {
        maxRetries: 3,
        delayMs: 2000,
        logger: this.logger,
        context: 'fetchBalance',
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to poll balance: ${msg}`);
    }
  }

  getLatestBalance(): Balances | null {
    return this.latestBalance;
  }

  // --- Query helpers ---

  async getRecentCandles(pair: string, timeframe: string, limit: number) {
    return this.prisma.candle.findMany({
      where: { pair, timeframe },
      orderBy: { openTime: 'desc' },
      take: limit,
    });
  }
}
