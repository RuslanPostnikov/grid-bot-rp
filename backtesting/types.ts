export interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BacktestConfig {
  initialCapital: number;
  activeCapitalPct: number; // default 60
  gridStepPct: number;
  atrPeriod: number; // default 14
  atrMultiplier: number; // default 3
  feeRate: number; // per side, default 0.001 (0.1%)
  slippagePct: number; // default 0.05%
  rebalanceIntervalCandles: number; // how often to rebalance (e.g. 24 for 24h with 1h candles)
}

export interface SimOrder {
  price: number;
  side: 'buy' | 'sell';
  quantity: number;
  placedAt: number; // candle index
}

export interface SimTrade {
  buyPrice: number;
  sellPrice: number;
  quantity: number;
  buyFee: number;
  sellFee: number;
  pnl: number;
  closedAt: number; // timestamp
}

export interface BacktestResult {
  config: BacktestConfig;
  totalCandles: number;
  periodStart: string;
  periodEnd: string;
  startPrice: number;
  endPrice: number;

  // PnL
  totalPnl: number;
  totalPnlPct: number;
  totalFees: number;
  netPnl: number;
  netPnlPct: number;

  // Trades
  totalCycles: number;
  profitableCycles: number;
  winRate: number;
  avgProfitPerCycle: number;

  // Risk
  maxDrawdown: number;
  maxDrawdownPct: number;

  // Sharpe
  sharpeRatio: number;

  // HODL comparison
  hodlPnl: number;
  hodlPnlPct: number;
  vsHodl: number; // grid PnL - HODL PnL

  // Grid stats
  totalRebalances: number;
  timesOutOfRange: number;

  // Equity curve (sampled)
  equityCurve: { timestamp: number; equity: number }[];
}

export const DEFAULT_CONFIG: BacktestConfig = {
  initialCapital: 10000,
  activeCapitalPct: 60,
  gridStepPct: 1.25,
  atrPeriod: 14,
  atrMultiplier: 3,
  feeRate: 0.001,
  slippagePct: 0.05,
  rebalanceIntervalCandles: 24,
};
