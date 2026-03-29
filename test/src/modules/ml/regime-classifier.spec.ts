import {
  classifyRegime,
  regimeToAction,
  type MarketRegime,
} from '@src/modules/ml/regime-classifier.js';
import {
  calculateMarketFeatures,
  calculateAvgBBWidth,
  calculateAvgAtrPct,
  type CandleInput,
} from '@src/modules/ml/market-features.js';

// --- Helpers ---

function generateCandles(
  count: number,
  trend: 'flat' | 'up' | 'down' | 'volatile',
): CandleInput[] {
  const candles: CandleInput[] = [];
  let price = 60000;

  for (let i = 0; i < count; i++) {
    let change: number;
    let range: number;

    switch (trend) {
      case 'flat':
        change = Math.sin(i * 0.3) * 100;
        range = 200;
        break;
      case 'up':
        change = 150 + Math.sin(i * 0.5) * 50;
        range = 300;
        break;
      case 'down':
        change = -150 + Math.sin(i * 0.5) * 50;
        range = 300;
        break;
      case 'volatile':
        change = Math.sin(i * 0.7) * 800;
        range = 1500;
        break;
    }

    price += change;
    const open = price;
    const close = price + change * 0.1;
    const high = Math.max(open, close) + range * 0.5;
    const low = Math.min(open, close) - range * 0.5;

    candles.push({
      open,
      high,
      low,
      close,
      volume:
        trend === 'volatile'
          ? 500 + Math.random() * 500
          : 100 + Math.random() * 50,
    });
  }

  return candles;
}

// --- Tests ---

describe('Market Features', () => {
  it('should return null for insufficient candles', () => {
    const candles = generateCandles(10, 'flat');
    const features = calculateMarketFeatures(candles);
    expect(features).toBeNull();
  });

  it('should calculate all features for sufficient candles', () => {
    const candles = generateCandles(100, 'flat');
    const features = calculateMarketFeatures(candles);

    expect(features).not.toBeNull();
    expect(features!.adx14).toBeGreaterThanOrEqual(0);
    expect(features!.rsi14).toBeGreaterThanOrEqual(0);
    expect(features!.rsi14).toBeLessThanOrEqual(100);
    expect(typeof features!.emaDiffPct).toBe('number');
    expect(typeof features!.atrPct).toBe('number');
    expect(typeof features!.bbWidth).toBe('number');
    expect(typeof features!.macdHistogram).toBe('number');
    expect(features!.volumeRatio).toBeGreaterThan(0);
  });
});

describe('Regime Classifier', () => {
  describe('direct feature input', () => {
    it('should classify FLAT: low ADX, small EMA diff, tight bands', () => {
      const result = classifyRegime(
        {
          adx14: 18,
          emaDiffPct: 0.1,
          atrPct: 2.0,
          bbWidth: 0.03,
          rsi14: 50,
          macdHistogram: 0.5,
          volumeRatio: 1.0,
        },
        0.05, // avg BB width (current < avg)
        2.5, // avg ATR %
      );

      expect(result.regime).toBe('flat');
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.reasons.length).toBeGreaterThan(0);
    });

    it('should classify UPTREND: high ADX, positive EMA diff, RSI > 55', () => {
      const result = classifyRegime(
        {
          adx14: 35,
          emaDiffPct: 1.5,
          atrPct: 2.5,
          bbWidth: 0.05,
          rsi14: 65,
          macdHistogram: 50,
          volumeRatio: 1.2,
        },
        0.05,
        2.5,
      );

      expect(result.regime).toBe('uptrend');
    });

    it('should classify DOWNTREND: high ADX, negative EMA diff, RSI < 45', () => {
      const result = classifyRegime(
        {
          adx14: 32,
          emaDiffPct: -1.8,
          atrPct: 2.5,
          bbWidth: 0.05,
          rsi14: 35,
          macdHistogram: -80,
          volumeRatio: 1.1,
        },
        0.05,
        2.5,
      );

      expect(result.regime).toBe('downtrend');
    });

    it('should classify VOLATILE: high ATR spike', () => {
      const result = classifyRegime(
        {
          adx14: 20,
          emaDiffPct: 0.2,
          atrPct: 5.0,
          bbWidth: 0.08,
          rsi14: 50,
          macdHistogram: 0,
          volumeRatio: 1.0,
        },
        0.05,
        2.5, // current ATR 5% > avg 2.5% * 1.5 = 3.75%
      );

      expect(result.regime).toBe('volatile');
    });

    it('should classify VOLATILE: high volume spike', () => {
      const result = classifyRegime(
        {
          adx14: 20,
          emaDiffPct: 0.2,
          atrPct: 2.0,
          bbWidth: 0.04,
          rsi14: 50,
          macdHistogram: 0,
          volumeRatio: 2.5,
        },
        0.05,
        2.5,
      );

      expect(result.regime).toBe('volatile');
    });
  });

  describe('from synthetic candles', () => {
    it('sideways data should tend toward flat', () => {
      const candles = generateCandles(100, 'flat');
      const features = calculateMarketFeatures(candles)!;
      const avgBB = calculateAvgBBWidth(candles);
      const avgATR = calculateAvgAtrPct(candles);

      const result = classifyRegime(features, avgBB, avgATR);
      // In synthetic flat data, should NOT be uptrend or downtrend
      expect(['flat', 'volatile']).toContain(result.regime);
    });

    it('uptrend data should detect uptrend or volatile', () => {
      const candles = generateCandles(100, 'up');
      const features = calculateMarketFeatures(candles)!;
      const avgBB = calculateAvgBBWidth(candles);
      const avgATR = calculateAvgAtrPct(candles);

      const result = classifyRegime(features, avgBB, avgATR);
      expect(['uptrend', 'volatile']).toContain(result.regime);
    });

    it('downtrend data should detect downtrend or volatile', () => {
      const candles = generateCandles(100, 'down');
      const features = calculateMarketFeatures(candles)!;
      const avgBB = calculateAvgBBWidth(candles);
      const avgATR = calculateAvgAtrPct(candles);

      const result = classifyRegime(features, avgBB, avgATR);
      expect(['downtrend', 'volatile']).toContain(result.regime);
    });
  });
});

describe('regimeToAction', () => {
  const cases: [MarketRegime, string][] = [
    ['flat', 'RUN_GRID'],
    ['uptrend', 'SHIFT_UP'],
    ['downtrend', 'PAUSE'],
    ['volatile', 'WIDEN_GRID'],
  ];

  it.each(cases)('%s → %s', (regime, expected) => {
    expect(regimeToAction(regime)).toBe(expected);
  });
});

describe('classifyRegime totalScore edge', () => {
  it('uses 0.5 confidence when every regime score stays zero', () => {
    const result = classifyRegime(
      {
        adx14: Number.NaN,
        emaDiffPct: Number.NaN,
        atrPct: Number.NaN,
        bbWidth: Number.NaN,
        rsi14: Number.NaN,
        macdHistogram: Number.NaN,
        volumeRatio: Number.NaN,
      },
      0,
      1,
    );
    expect(result.confidence).toBe(0.5);
  });
});
