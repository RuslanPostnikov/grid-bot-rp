import type {
  RiskConfig,
  PositionSizing,
  RiskCheckResult,
  RiskLevel,
} from './risk.types.js';

/**
 * Calculate position sizing: 60% active / 30% reserve / 10% buffer.
 */
export function calculatePositionSizing(
  totalCapital: number,
  config: RiskConfig,
): PositionSizing {
  return {
    totalCapital,
    activeCapital: totalCapital * (config.activeCapitalPct / 100),
    reserveCapital: totalCapital * (config.reserveCapitalPct / 100),
    bufferCapital: totalCapital * (config.minBufferPct / 100),
  };
}

/**
 * Calculate drawdown percentage from peak to current.
 */
export function calculateDrawdownPct(
  peakBalance: number,
  currentBalance: number,
): number {
  if (peakBalance <= 0) return 0;
  const drawdown = ((peakBalance - currentBalance) / peakBalance) * 100;
  return Math.max(0, drawdown);
}

/**
 * Calculate price deviation from the nearest grid boundary.
 * Returns positive % if price is outside the grid.
 */
export function calculatePriceDeviation(
  currentPrice: number,
  lowerBound: number,
  upperBound: number,
): number {
  if (currentPrice < lowerBound) {
    return ((lowerBound - currentPrice) / lowerBound) * 100;
  }
  if (currentPrice > upperBound) {
    return ((currentPrice - upperBound) / upperBound) * 100;
  }
  return 0;
}

/**
 * Determine risk level based on current drawdown and price deviation.
 */
export function evaluateRisk(
  dailyDrawdownPct: number,
  weeklyDrawdownPct: number,
  priceDeviationPct: number,
  currentBalance: number,
  initialCapital: number,
  config: RiskConfig,
): RiskCheckResult {
  const reasons: string[] = [];
  let level: RiskLevel = 'normal';
  const minAllowedBalance = initialCapital * (config.minBufferPct / 100);

  // Level 3 — full stop (highest priority)
  if (weeklyDrawdownPct >= config.maxWeeklyDrawdownPct) {
    level = 'stop';
    reasons.push(
      `Weekly drawdown ${weeklyDrawdownPct.toFixed(1)}% >= ${config.maxWeeklyDrawdownPct}%`,
    );
  }

  if (currentBalance <= minAllowedBalance) {
    level = 'stop';
    reasons.push(
      `Balance $${currentBalance.toFixed(2)} <= min buffer $${minAllowedBalance.toFixed(2)}`,
    );
  }

  // Level 2 — pause
  if (level !== 'stop') {
    if (dailyDrawdownPct >= config.maxDailyDrawdownPct) {
      level = 'pause';
      reasons.push(
        `Daily drawdown ${dailyDrawdownPct.toFixed(1)}% >= ${config.maxDailyDrawdownPct}%`,
      );
    }

    if (priceDeviationPct >= config.maxPriceDeviationPct) {
      level = 'pause';
      reasons.push(
        `Price deviation ${priceDeviationPct.toFixed(1)}% >= ${config.maxPriceDeviationPct}%`,
      );
    }
  }

  // Level 1 — warning
  if (level === 'normal') {
    if (dailyDrawdownPct >= config.warningDrawdownPct) {
      level = 'warning';
      reasons.push(
        `Daily drawdown ${dailyDrawdownPct.toFixed(1)}% >= warning threshold ${config.warningDrawdownPct}%`,
      );
    }
  }

  return {
    level,
    reasons,
    dailyDrawdownPct,
    weeklyDrawdownPct,
    priceDeviationPct,
    currentBalance,
    minAllowedBalance,
  };
}
