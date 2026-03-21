import type { OHLCV } from './types.js';

export function calculateATR(candles: OHLCV[], period: number): number[] {
  if (candles.length < 2) return [];

  const trueRanges: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose),
    );
    trueRanges.push(tr);
  }

  const atrValues: number[] = [];

  // First ATR is SMA of first `period` TRs
  if (trueRanges.length < period) return [];

  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += trueRanges[i];
  }
  atrValues.push(sum / period);

  // Subsequent ATRs use smoothing
  for (let i = period; i < trueRanges.length; i++) {
    const prevATR = atrValues[atrValues.length - 1];
    const newATR = (prevATR * (period - 1) + trueRanges[i]) / period;
    atrValues.push(newATR);
  }

  return atrValues;
}
