export interface MarketSnapshot {
  pair: string;
  currentPrice: number;
  priceChange24h: number;
  volume24h: number;
  regime: string;
  regimeConfidence: number;
  gridActive: boolean;
  gridBounds: { lower: number; upper: number } | null;
  gridStepPct: number | null;
  balance: { usdt: number; btc: number };
  recentTrades: { side: string; price: number; pnl: number | null; time: string }[];
  totalPnl24h: number;
  dailyDrawdownPct: number;
  weeklyDrawdownPct: number;
  riskLevel: string;
  indicators: {
    rsi14: number | null;
    adx14: number | null;
    atrPct: number | null;
    macdHistogram: number | null;
  };
}

export interface ClaudeAdviceResponse {
  market_assessment: string;
  grid_recommendation: {
    action: 'keep' | 'adjust' | 'pause' | 'restart';
    lower_bound: number | null;
    upper_bound: number | null;
    grid_step_pct: number | null;
    reason: string;
  };
  risk_flags: string[];
  confidence: number;
  next_review_hours: number;
}

export type ClaudeTrigger =
  | 'scheduled_4h'
  | 'price_out_of_range'
  | 'drawdown_warning'
  | 'regime_change';
