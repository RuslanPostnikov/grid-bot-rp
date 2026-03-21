import { ADX, RSI, MACD, BollingerBands, EMA, ATR, SMA } from 'technicalindicators';

export interface CandleInput {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketFeatures {
  adx14: number;
  emaDiffPct: number; // (EMA20 - EMA50) / EMA50 * 100
  atrPct: number; // ATR / price * 100
  bbWidth: number; // (upper - lower) / middle
  rsi14: number;
  macdHistogram: number;
  volumeRatio: number; // current volume / SMA(volume, 20)
}

const MIN_CANDLES = 60; // need at least 50 for EMA50 + buffer

export function calculateMarketFeatures(
  candles: CandleInput[],
): MarketFeatures | null {
  if (candles.length < MIN_CANDLES) return null;

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);

  // ADX(14)
  const adxValues = ADX.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: 14,
  });
  const adx14 = last(adxValues)?.adx ?? 0;

  // EMA(20) and EMA(50)
  const ema20Values = EMA.calculate({ values: closes, period: 20 });
  const ema50Values = EMA.calculate({ values: closes, period: 50 });
  const ema20 = last(ema20Values) ?? 0;
  const ema50 = last(ema50Values) ?? 1;
  const emaDiffPct = ((ema20 - ema50) / ema50) * 100;

  // ATR(14)
  const atrValues = ATR.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: 14,
  });
  const atr = last(atrValues) ?? 0;
  const currentPrice = closes[closes.length - 1];
  const atrPct = (atr / currentPrice) * 100;

  // Bollinger Bands(20, 2)
  const bbValues = BollingerBands.calculate({
    values: closes,
    period: 20,
    stdDev: 2,
  });
  const bb = last(bbValues);
  const bbWidth = bb ? (bb.upper - bb.lower) / bb.middle : 0;

  // RSI(14)
  const rsiValues = RSI.calculate({ values: closes, period: 14 });
  const rsi14 = last(rsiValues) ?? 50;

  // MACD(12, 26, 9)
  const macdValues = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const macd = last(macdValues);
  const macdHistogram = macd?.histogram ?? 0;

  // Volume ratio: current / SMA(20)
  const volSmaValues = SMA.calculate({ values: volumes, period: 20 });
  const volSma = last(volSmaValues) ?? 1;
  const currentVol = volumes[volumes.length - 1];
  const volumeRatio = currentVol / volSma;

  return {
    adx14: round(adx14),
    emaDiffPct: round(emaDiffPct),
    atrPct: round(atrPct),
    bbWidth: round(bbWidth),
    rsi14: round(rsi14),
    macdHistogram: round(macdHistogram),
    volumeRatio: round(volumeRatio),
  };
}

export function calculateAvgBBWidth(candles: CandleInput[]): number {
  const closes = candles.map((c) => c.close);
  const bbValues = BollingerBands.calculate({
    values: closes,
    period: 20,
    stdDev: 2,
  });
  if (bbValues.length === 0) return 0;
  const sum = bbValues.reduce(
    (s, bb) => s + (bb.upper - bb.lower) / bb.middle,
    0,
  );
  return sum / bbValues.length;
}

export function calculateAvgAtrPct(candles: CandleInput[]): number {
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);

  const atrValues = ATR.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: 14,
  });

  if (atrValues.length === 0) return 0;

  // Pair ATR values with closes to get %
  const offset = closes.length - atrValues.length;
  let sum = 0;
  for (let i = 0; i < atrValues.length; i++) {
    sum += (atrValues[i] / closes[offset + i]) * 100;
  }
  return sum / atrValues.length;
}

function last<T>(arr: T[]): T | undefined {
  return arr[arr.length - 1];
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
