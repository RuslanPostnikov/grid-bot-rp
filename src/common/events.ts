export const BOT_EVENTS = {
  RISK_WARNING: 'risk.warning',
  RISK_PAUSE: 'risk.pause',
  PRICE_OUT_OF_RANGE: 'risk.priceOutOfRange',
  REGIME_CHANGE: 'ml.regimeChange',
  CLAUDE_ADVICE_PENDING: 'claude.advicePending',
} as const;

export interface ClaudeAdvicePendingPayload {
  adviceId: bigint;
  assessment: string;
  action: string;
  reason: string;
  confidence: number;
}

export interface RegimeChangePayload {
  pair: string;
  oldRegime: string | null;
  newRegime: string;
  confidence: number;
}

export interface RiskEventPayload {
  level: string;
  reasons: string[];
  dailyDrawdownPct: number;
  weeklyDrawdownPct: number;
}
