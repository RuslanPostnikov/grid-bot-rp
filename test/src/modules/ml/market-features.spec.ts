import * as ti from 'technicalindicators';
import {
  calculateMarketFeatures,
  calculateAvgBBWidth,
  calculateAvgAtrPct,
  type CandleInput,
} from '@src/modules/ml/market-features.js';

function baseCandle(i: number): CandleInput {
  const p = 100 + i * 0.01;
  return {
    open: p,
    high: p + 0.5,
    low: p - 0.5,
    close: p,
    volume: 1000 + i,
  };
}

function manyCandles(n: number): CandleInput[] {
  return Array.from({ length: n }, (_, i) => baseCandle(i));
}

describe('market-features', () => {
  it('returns null when fewer than 60 candles', () => {
    expect(calculateMarketFeatures(manyCandles(59))).toBeNull();
  });

  it('computes features for 60+ candles', () => {
    const f = calculateMarketFeatures(manyCandles(65));
    expect(f).not.toBeNull();
    expect(f!.adx14).toBeGreaterThanOrEqual(0);
  });

  it('uses ADX fallback when last entry has no adx', () => {
    const spy = jest.spyOn(ti.ADX, 'calculate').mockReturnValue([{}] as never);
    const f = calculateMarketFeatures(manyCandles(65));
    expect(f!.adx14).toBe(0);
    spy.mockRestore();
  });

  it('uses bbWidth 0 when last BB is undefined', () => {
    const spy = jest
      .spyOn(ti.BollingerBands, 'calculate')
      .mockReturnValue([] as never);
    const f = calculateMarketFeatures(manyCandles(65));
    expect(f!.bbWidth).toBe(0);
    spy.mockRestore();
  });

  it('uses macd histogram 0 when last MACD has no histogram', () => {
    const spy = jest.spyOn(ti.MACD, 'calculate').mockReturnValue([{}] as never);
    const f = calculateMarketFeatures(manyCandles(65));
    expect(f!.macdHistogram).toBe(0);
    spy.mockRestore();
  });

  it('calculateAvgBBWidth returns 0 for empty BB series', () => {
    const spy = jest
      .spyOn(ti.BollingerBands, 'calculate')
      .mockReturnValue([] as never);
    expect(calculateAvgBBWidth(manyCandles(65))).toBe(0);
    spy.mockRestore();
  });

  it('calculateAvgAtrPct returns 0 when ATR series empty', () => {
    const spy = jest.spyOn(ti.ATR, 'calculate').mockReturnValue([] as never);
    expect(calculateAvgAtrPct(manyCandles(65))).toBe(0);
    spy.mockRestore();
  });

  it('uses EMA fallbacks when last values missing', () => {
    const spy = jest.spyOn(ti.EMA, 'calculate').mockReturnValue([] as never);
    const f = calculateMarketFeatures(manyCandles(65));
    expect(f).not.toBeNull();
    expect(f!.emaDiffPct).toBeDefined();
    spy.mockRestore();
  });

  it('uses RSI fallback when series empty', () => {
    const spy = jest.spyOn(ti.RSI, 'calculate').mockReturnValue([] as never);
    const f = calculateMarketFeatures(manyCandles(65));
    expect(f!.rsi14).toBe(50);
    spy.mockRestore();
  });

  it('uses volume SMA fallback when series empty', () => {
    const spy = jest.spyOn(ti.SMA, 'calculate').mockReturnValue([] as never);
    const f = calculateMarketFeatures(manyCandles(65));
    expect(f!.volumeRatio).toBeDefined();
    spy.mockRestore();
  });

  it('uses ATR fallback when last value missing', () => {
    const spy = jest.spyOn(ti.ATR, 'calculate').mockReturnValue([] as never);
    const f = calculateMarketFeatures(manyCandles(65));
    expect(f!.atrPct).toBe(0);
    spy.mockRestore();
  });
});
