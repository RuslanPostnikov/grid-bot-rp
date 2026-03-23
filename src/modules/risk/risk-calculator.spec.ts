import {
  calculatePositionSizing,
  calculateDrawdownPct,
  calculatePriceDeviation,
  evaluateRisk,
} from './risk-calculator';
import { DEFAULT_RISK_CONFIG } from './risk.types';

describe('risk-calculator', () => {
  describe('calculatePositionSizing', () => {
    it('splits capital 60/30/10', () => {
      const result = calculatePositionSizing(10_000, DEFAULT_RISK_CONFIG);
      expect(result.totalCapital).toBe(10_000);
      expect(result.activeCapital).toBe(6_000);
      expect(result.reserveCapital).toBe(3_000);
      expect(result.bufferCapital).toBe(1_000);
    });

    it('handles zero capital', () => {
      const result = calculatePositionSizing(0, DEFAULT_RISK_CONFIG);
      expect(result.activeCapital).toBe(0);
      expect(result.reserveCapital).toBe(0);
      expect(result.bufferCapital).toBe(0);
    });
  });

  describe('calculateDrawdownPct', () => {
    it('returns 0 when no drawdown', () => {
      expect(calculateDrawdownPct(10_000, 10_000)).toBe(0);
    });

    it('calculates correct drawdown', () => {
      expect(calculateDrawdownPct(10_000, 9_500)).toBe(5);
      expect(calculateDrawdownPct(10_000, 8_500)).toBe(15);
    });

    it('returns 0 for peak <= 0', () => {
      expect(calculateDrawdownPct(0, 100)).toBe(0);
    });

    it('returns 0 when current > peak (no drawdown)', () => {
      expect(calculateDrawdownPct(10_000, 11_000)).toBe(0);
    });
  });

  describe('calculatePriceDeviation', () => {
    it('returns 0 when price is within grid', () => {
      expect(calculatePriceDeviation(100, 90, 110)).toBe(0);
    });

    it('calculates deviation below grid', () => {
      // price=87, lower=90 → (90-87)/90 = 3.33%
      const dev = calculatePriceDeviation(87, 90, 110);
      expect(dev).toBeCloseTo(3.33, 1);
    });

    it('calculates deviation above grid', () => {
      // price=113.3, upper=110 → (113.3-110)/110 = 3%
      const dev = calculatePriceDeviation(113.3, 90, 110);
      expect(dev).toBeCloseTo(3, 0);
    });

    it('returns 0 at exact boundaries', () => {
      expect(calculatePriceDeviation(90, 90, 110)).toBe(0);
      expect(calculatePriceDeviation(110, 90, 110)).toBe(0);
    });
  });

  describe('evaluateRisk', () => {
    const config = DEFAULT_RISK_CONFIG;
    const initialCapital = 10_000;

    it('returns normal when everything is fine', () => {
      const result = evaluateRisk(0, 0, 0, 10_000, initialCapital, config);
      expect(result.level).toBe('normal');
      expect(result.reasons).toHaveLength(0);
    });

    it('returns warning at 3% daily drawdown', () => {
      const result = evaluateRisk(3.5, 0, 0, 9_650, initialCapital, config);
      expect(result.level).toBe('warning');
      expect(result.reasons).toHaveLength(1);
      expect(result.reasons[0]).toContain('warning threshold');
    });

    it('returns pause at 5% daily drawdown', () => {
      const result = evaluateRisk(5.5, 0, 0, 9_450, initialCapital, config);
      expect(result.level).toBe('pause');
      expect(result.reasons[0]).toContain('Daily drawdown');
    });

    it('returns pause when price deviates > 5%', () => {
      const result = evaluateRisk(0, 0, 5.1, 10_000, initialCapital, config);
      expect(result.level).toBe('pause');
      expect(result.reasons[0]).toContain('Price deviation');
    });

    it('returns stop at 15% weekly drawdown', () => {
      const result = evaluateRisk(0, 16, 0, 8_400, initialCapital, config);
      expect(result.level).toBe('stop');
      expect(result.reasons[0]).toContain('Weekly drawdown');
    });

    it('returns stop when balance hits buffer minimum', () => {
      // 10% of 10_000 = 1_000
      const result = evaluateRisk(0, 0, 0, 900, initialCapital, config);
      expect(result.level).toBe('stop');
      expect(result.reasons[0]).toContain('min buffer');
    });

    it('stop overrides pause', () => {
      // Both daily drawdown (pause) and weekly drawdown (stop)
      const result = evaluateRisk(6, 16, 0, 8_400, initialCapital, config);
      expect(result.level).toBe('stop');
    });

    it('multiple reasons accumulate', () => {
      // Weekly stop + balance stop
      const result = evaluateRisk(0, 20, 0, 500, initialCapital, config);
      expect(result.level).toBe('stop');
      expect(result.reasons.length).toBeGreaterThanOrEqual(2);
    });

    it('includes all metrics in result', () => {
      const result = evaluateRisk(2.5, 5.0, 1.5, 9_500, initialCapital, config);
      expect(result.dailyDrawdownPct).toBe(2.5);
      expect(result.weeklyDrawdownPct).toBe(5.0);
      expect(result.priceDeviationPct).toBe(1.5);
      expect(result.currentBalance).toBe(9_500);
      expect(result.minAllowedBalance).toBe(1_000);
    });
  });
});
