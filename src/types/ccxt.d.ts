declare module 'ccxt' {
  export class Exchange {
    setSandboxMode(enabled: boolean): void;
    fetchOHLCV(
      symbol: string,
      timeframe?: string,
      since?: number,
      limit?: number,
    ): Promise<OHLCV[]>;
    fetchTicker(symbol: string): Promise<Ticker>;
    fetchBalance(): Promise<Balances>;
    fetchOpenOrders(symbol?: string): Promise<Order[]>;
    fetchOrder(id: string, symbol?: string): Promise<Order>;
    createOrder(
      symbol: string,
      type: string,
      side: string,
      amount: number,
      price?: number,
    ): Promise<Order>;
    cancelOrder(id: string, symbol?: string): Promise<Order>;
  }

  export type OHLCV = [number, number, number, number, number, number];

  export interface Ticker {
    symbol: string;
    last?: number;
    bid?: number;
    ask?: number;
    high?: number;
    low?: number;
    volume?: number;
    timestamp?: number;
  }

  export interface Balances {
    free: Record<string, number>;
    used: Record<string, number>;
    total: Record<string, number>;
    [key: string]: unknown;
  }

  export interface Order {
    id: string;
    symbol: string;
    type: string;
    side: string;
    price: number;
    amount: number;
    filled: number;
    remaining: number;
    status: string;
    timestamp?: number;
    datetime?: string;
    fee?: { cost: number; currency: string };
    [key: string]: unknown;
  }

  const ccxt: Record<string, unknown>;
  export default ccxt;
}
