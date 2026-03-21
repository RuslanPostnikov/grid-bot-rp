export const BOT_EVENTS = {
  RISK_WARNING: 'risk.warning',
  RISK_PAUSE: 'risk.pause',
  PRICE_OUT_OF_RANGE: 'risk.priceOutOfRange',
  REGIME_CHANGE: 'ml.regimeChange',
} as const;

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
