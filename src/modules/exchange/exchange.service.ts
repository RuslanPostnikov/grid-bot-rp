import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import ccxt, {
  type Exchange,
  type OHLCV,
  type Ticker,
  type Balances,
  type Order,
  type OrderBook,
} from 'ccxt';

@Injectable()
export class ExchangeService implements OnModuleInit {
  private readonly logger = new Logger(ExchangeService.name);
  private exchange!: Exchange;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const exchangeId = this.config.get<string>('exchange.id', 'binance');
    const apiKey = this.config.get<string>('exchange.apiKey', '');
    const apiSecret = this.config.get<string>('exchange.apiSecret', '');
    const testnet = this.config.get<boolean>('exchange.testnet', true);

    const ExchangeClass = (ccxt as unknown as Record<string, unknown>)[
      exchangeId
    ] as new (config: Record<string, unknown>) => Exchange;

    if (!ExchangeClass) {
      throw new Error(`Exchange "${exchangeId}" not found in ccxt`);
    }

    this.exchange = new ExchangeClass({
      apiKey,
      secret: apiSecret,
      enableRateLimit: true,
    });

    if (testnet) {
      this.exchange.setSandboxMode(true);
    }

    this.logger.log(
      `Exchange initialized: ${exchangeId} (testnet: ${String(testnet)})`,
    );
  }

  getExchange(): Exchange {
    return this.exchange;
  }

  async fetchOHLCV(
    symbol: string,
    timeframe: string,
    since?: number,
    limit?: number,
  ): Promise<OHLCV[]> {
    return this.exchange.fetchOHLCV(symbol, timeframe, since, limit);
  }

  async fetchTicker(symbol: string): Promise<Ticker> {
    return this.exchange.fetchTicker(symbol);
  }

  async fetchBalance(): Promise<Balances> {
    return this.exchange.fetchBalance();
  }

  async fetchOpenOrders(symbol?: string): Promise<Order[]> {
    return this.exchange.fetchOpenOrders(symbol);
  }

  async createOrder(
    symbol: string,
    type: string,
    side: string,
    amount: number,
    price?: number,
  ): Promise<Order> {
    return this.exchange.createOrder(symbol, type, side, amount, price);
  }

  async cancelOrder(id: string, symbol?: string): Promise<Order> {
    return this.exchange.cancelOrder(id, symbol);
  }

  async fetchOrderBook(symbol: string, limit?: number): Promise<OrderBook> {
    return this.exchange.fetchOrderBook(symbol, limit);
  }
}
