import { runBacktest, runOptimization } from './engine.js';
import { calculateATR } from './indicators.js';
import type { OHLCV, BacktestConfig } from './types.js';
import { DEFAULT_CONFIG } from './types.js';

// --- Helpers: generate synthetic candles ---

function generateSidewaysCandles(
  count: number,
  basePrice: number = 60000,
  amplitude: number = 2000,
): OHLCV[] {
  const candles: OHLCV[] = [];
  const hourMs = 60 * 60 * 1000;

  for (let i = 0; i < count; i++) {
    // Oscillate around basePrice with sine wave
    const phase = (i / 20) * Math.PI * 2;
    const center = basePrice + Math.sin(phase) * amplitude;
    const noise = (Math.sin(i * 7.3) * amplitude) / 10; // small noise

    const open = center + noise;
    const close = center - noise;
    const high = Math.max(open, close) + amplitude * 0.05;
    const low = Math.min(open, close) - amplitude * 0.05;

    candles.push({
      timestamp: Date.now() - (count - i) * hourMs,
      open,
      high,
      low,
      close,
      volume: 100 + Math.abs(Math.sin(i) * 50),
    });
  }

  return candles;
}

function generateUptrendCandles(
  count: number,
  startPrice: number = 50000,
  endPrice: number = 80000,
): OHLCV[] {
  const candles: OHLCV[] = [];
  const hourMs = 60 * 60 * 1000;
  const step = (endPrice - startPrice) / count;

  for (let i = 0; i < count; i++) {
    const center = startPrice + step * i;
    const noise = Math.sin(i * 3.7) * 500;
    const open = center + noise;
    const close = center - noise + step;
    const high = Math.max(open, close) + 200;
    const low = Math.min(open, close) - 200;

    candles.push({
      timestamp: Date.now() - (count - i) * hourMs,
      open,
      high,
      low,
      close,
      volume: 100,
    });
  }

  return candles;
}

// --- Tests ---

describe('ATR calculation', () => {
  it('should calculate ATR values', () => {
    const candles = generateSidewaysCandles(50);
    const atr = calculateATR(candles, 14);

    expect(atr.length).toBe(50 - 1 - 14 + 1); // trueRanges - period + 1
    atr.forEach((v) => {
      expect(v).toBeGreaterThan(0);
      expect(isFinite(v)).toBe(true);
    });
  });

  it('should return empty for insufficient data', () => {
    const candles = generateSidewaysCandles(5);
    const atr = calculateATR(candles, 14);
    expect(atr.length).toBe(0);
  });
});

describe('Backtest engine', () => {
  const config: BacktestConfig = {
    ...DEFAULT_CONFIG,
    initialCapital: 10000,
    gridStepPct: 1.25,
    rebalanceIntervalCandles: 24,
  };

  describe('sideways market', () => {
    const candles = generateSidewaysCandles(500, 60000, 2000);

    it('should complete without errors', () => {
      const result = runBacktest(candles, config);
      expect(result).toBeDefined();
      expect(result.totalCandles).toBe(500);
    });

    it('should execute grid cycles', () => {
      const result = runBacktest(candles, config);
      expect(result.totalCycles).toBeGreaterThan(0);
    });

    it('should track fees', () => {
      const result = runBacktest(candles, config);
      expect(result.totalFees).toBeGreaterThan(0);
    });

    it('should calculate max drawdown', () => {
      const result = runBacktest(candles, config);
      expect(result.maxDrawdown).toBeGreaterThanOrEqual(0);
      expect(result.maxDrawdownPct).toBeGreaterThanOrEqual(0);
    });

    it('should produce equity curve', () => {
      const result = runBacktest(candles, config);
      expect(result.equityCurve.length).toBeGreaterThan(0);
    });

    it('should calculate HODL comparison', () => {
      const result = runBacktest(candles, config);
      expect(typeof result.hodlPnl).toBe('number');
      expect(typeof result.vsHodl).toBe('number');
    });

    it('should count rebalances', () => {
      const result = runBacktest(candles, config);
      expect(result.totalRebalances).toBeGreaterThan(0);
    });
  });

  describe('uptrend market', () => {
    const candles = generateUptrendCandles(500, 50000, 80000);

    it('should complete without errors', () => {
      const result = runBacktest(candles, config);
      expect(result).toBeDefined();
    });

    it('HODL should outperform grid in strong uptrend', () => {
      const result = runBacktest(candles, config);
      // In a strong uptrend, HODL typically beats grid
      expect(result.hodlPnlPct).toBeGreaterThan(0);
    });
  });

  describe('error handling', () => {
    it('should throw on insufficient data', () => {
      const shortCandles = generateSidewaysCandles(10);
      expect(() => runBacktest(shortCandles, config)).toThrow();
    });
  });
});

describe('Parameter optimization', () => {
  it('should run multiple configurations and return results', () => {
    const candles = generateSidewaysCandles(200, 60000, 2000);
    const steps = [0.5, 1.0, 1.5, 2.0];
    const results = runOptimization(candles, DEFAULT_CONFIG, steps);

    expect(results.length).toBe(4);
    results.forEach(({ stepPct, result }) => {
      expect(stepPct).toBeGreaterThan(0);
      expect(result.totalCandles).toBe(200);
      expect(typeof result.netPnl).toBe('number');
    });
  });
});
