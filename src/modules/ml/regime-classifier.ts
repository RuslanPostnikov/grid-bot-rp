import type { MarketFeatures } from './market-features.js';

export type MarketRegime = 'flat' | 'uptrend' | 'downtrend' | 'volatile';

export interface ClassificationResult {
  regime: MarketRegime;
  confidence: number; // 0.0 - 1.0
  reasons: string[];
}

/**
 * Rule-based market regime classifier v1.
 *
 * Rules from plan:
 *   FLAT:      ADX < 25 AND |emaDiff| < 0.5% AND bbWidth < avgBBWidth
 *   UPTREND:   ADX > 25 AND emaDiff > 0.5% AND RSI > 55
 *   DOWNTREND: ADX > 25 AND emaDiff < -0.5% AND RSI < 45
 *   VOLATILE:  atrPct > avgAtrPct * 1.5 OR volumeRatio > 2.0
 */
export function classifyRegime(
  features: MarketFeatures,
  avgBBWidth: number,
  avgAtrPct: number,
): ClassificationResult {
  const scores: Record<MarketRegime, { score: number; reasons: string[] }> = {
    flat: { score: 0, reasons: [] },
    uptrend: { score: 0, reasons: [] },
    downtrend: { score: 0, reasons: [] },
    volatile: { score: 0, reasons: [] },
  };

  // --- Volatile checks (highest priority) ---
  const isVolatile =
    features.atrPct > avgAtrPct * 1.5 || features.volumeRatio > 2.0;

  if (features.atrPct > avgAtrPct * 1.5) {
    scores.volatile.score += 5;
    scores.volatile.reasons.push(
      `ATR% ${features.atrPct.toFixed(2)} > ${(avgAtrPct * 1.5).toFixed(2)} (1.5x avg)`,
    );
  }
  if (features.volumeRatio > 2.0) {
    scores.volatile.score += 4;
    scores.volatile.reasons.push(
      `Volume ratio ${features.volumeRatio.toFixed(2)} > 2.0`,
    );
  }

  // --- Flat checks (suppressed when volatile) ---
  if (features.adx14 < 25 && !isVolatile) {
    scores.flat.score += 2;
    scores.flat.reasons.push(`ADX ${features.adx14.toFixed(1)} < 25`);
  }
  if (Math.abs(features.emaDiffPct) < 0.5) {
    scores.flat.score += 1;
    scores.flat.reasons.push(
      `|EMA diff| ${Math.abs(features.emaDiffPct).toFixed(3)}% < 0.5%`,
    );
  }
  if (avgBBWidth > 0 && features.bbWidth < avgBBWidth) {
    scores.flat.score += 1;
    scores.flat.reasons.push(
      `BB width ${features.bbWidth.toFixed(3)} < avg ${avgBBWidth.toFixed(3)}`,
    );
  }

  // --- Uptrend checks ---
  if (features.adx14 > 25) {
    scores.uptrend.score += 1;
    scores.downtrend.score += 1;
  }
  if (features.emaDiffPct > 0.5) {
    scores.uptrend.score += 2;
    scores.uptrend.reasons.push(
      `EMA diff ${features.emaDiffPct.toFixed(3)}% > 0.5%`,
    );
  }
  if (features.rsi14 > 55) {
    scores.uptrend.score += 1;
    scores.uptrend.reasons.push(`RSI ${features.rsi14.toFixed(1)} > 55`);
  }
  if (features.adx14 > 25 && features.emaDiffPct > 0.5) {
    scores.uptrend.reasons.push(`ADX ${features.adx14.toFixed(1)} > 25 (trending)`);
  }

  // --- Downtrend checks ---
  if (features.emaDiffPct < -0.5) {
    scores.downtrend.score += 2;
    scores.downtrend.reasons.push(
      `EMA diff ${features.emaDiffPct.toFixed(3)}% < -0.5%`,
    );
  }
  if (features.rsi14 < 45) {
    scores.downtrend.score += 1;
    scores.downtrend.reasons.push(`RSI ${features.rsi14.toFixed(1)} < 45`);
  }
  if (features.adx14 > 25 && features.emaDiffPct < -0.5) {
    scores.downtrend.reasons.push(`ADX ${features.adx14.toFixed(1)} > 25 (trending)`);
  }

  // --- MACD confirmation ---
  if (features.macdHistogram > 0) {
    scores.uptrend.score += 0.5;
  } else if (features.macdHistogram < 0) {
    scores.downtrend.score += 0.5;
  }

  // Pick winner
  const entries = Object.entries(scores) as [
    MarketRegime,
    { score: number; reasons: string[] },
  ][];
  entries.sort((a, b) => b[1].score - a[1].score);

  const winner = entries[0];
  const runnerUp = entries[1];
  const totalScore = entries.reduce((s, e) => s + e[1].score, 0);

  // Confidence: how dominant is the winner
  const confidence =
    totalScore > 0
      ? Math.min(1, (winner[1].score - runnerUp[1].score * 0.5) / totalScore)
      : 0.5;

  return {
    regime: winner[0],
    confidence: Math.round(confidence * 100) / 100,
    reasons: winner[1].reasons,
  };
}

/**
 * Maps regime to grid action.
 */
export type GridAction = 'RUN_GRID' | 'SHIFT_UP' | 'PAUSE' | 'WIDEN_GRID';

export function regimeToAction(regime: MarketRegime): GridAction {
  switch (regime) {
    case 'flat':
      return 'RUN_GRID';
    case 'uptrend':
      return 'SHIFT_UP';
    case 'downtrend':
      return 'PAUSE';
    case 'volatile':
      return 'WIDEN_GRID';
  }
}
