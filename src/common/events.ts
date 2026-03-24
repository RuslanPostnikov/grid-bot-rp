export const BOT_EVENTS = {
  RISK_WARNING: 'risk.warning',
  RISK_PAUSE: 'risk.pause',
  PRICE_OUT_OF_RANGE: 'risk.priceOutOfRange',
  REGIME_CHANGE: 'ml.regimeChange',
  CLAUDE_ADVICE_PENDING: 'claude.advicePending',
  ORDER_FILLED: 'grid.orderFilled',
  BOT_RESUMED: 'bot.resumed',
  STALE_ORDERS: 'grid.staleOrders',
  STOP_LOSS_TRIGGERED: 'risk.stopLoss',
} as const;

export interface ClaudeAdvicePendingPayload {
  adviceId: bigint;
  assessment: string;
  action: string;
  reason: string;
  confidence: number;
}

export interface BotResumedPayload {
  source: 'risk_auto_resume' | 'claude_advice' | 'manual';
  suggestedParams?: {
    lowerBound: number;
    upperBound: number;
    gridStepPct: number;
  };
}

export interface RegimeChangePayload {
  pair: string;
  oldRegime: string | null;
  newRegime: string;
  confidence: number;
  action: 'RUN_GRID' | 'SHIFT_UP' | 'PAUSE' | 'WIDEN_GRID';
}

export interface RiskEventPayload {
  level: string;
  reasons: string[];
  dailyDrawdownPct: number;
  weeklyDrawdownPct: number;
}

export interface OrderFilledPayload {
  side: 'buy' | 'sell';
  price: number;
  quantity: number;
  counterPrice: number;
  expectedPnl: number;
}
