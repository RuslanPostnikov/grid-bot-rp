export interface RiskConfig {
  /** Max daily drawdown before pausing grid (-5%) */
  maxDailyDrawdownPct: number;
  /** Max weekly drawdown before full stop (-15%) */
  maxWeeklyDrawdownPct: number;
  /** Max price deviation from grid before stopping (3%) */
  maxPriceDeviationPct: number;
  /** How far below lower bound before hard stop-loss sell (10%) */
  stopLossBelowBoundPct: number;
  /** Min balance buffer that must never be used (10%) */
  minBufferPct: number;
  /** Active trading capital fraction (60%) */
  activeCapitalPct: number;
  /** Reserve capital for rebalancing (30%) */
  reserveCapitalPct: number;
  /** Warning drawdown threshold before hard stop (3%) */
  warningDrawdownPct: number;
}

export interface PositionSizing {
  totalCapital: number;
  activeCapital: number;
  reserveCapital: number;
  bufferCapital: number;
}

export type RiskLevel = 'normal' | 'warning' | 'pause' | 'stop';

export interface RiskCheckResult {
  level: RiskLevel;
  reasons: string[];
  dailyDrawdownPct: number;
  weeklyDrawdownPct: number;
  priceDeviationPct: number;
  currentBalance: number;
  minAllowedBalance: number;
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  maxDailyDrawdownPct: 5,
  maxWeeklyDrawdownPct: 15,
  maxPriceDeviationPct: 5,
  stopLossBelowBoundPct: 10,
  minBufferPct: 10,
  activeCapitalPct: 60,
  reserveCapitalPct: 30,
  warningDrawdownPct: 3,
};
