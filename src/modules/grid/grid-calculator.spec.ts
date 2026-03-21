import {
  calculateGridParams,
  calculateCapitalPerLevel,
  generateGridOrders,
  onBuyFilled,
  onSellFilled,
  calculateCyclePnl,
  classifyVolatility,
  checkRebalanceTriggers,
  calculateRebalance,
  isPriceInGrid,
  priceDeviationFromGrid,
} from './grid-calculator.js';

describe('Grid Calculator', () => {
  // --- calculateGridParams ---
  describe('calculateGridParams', () => {
    it('should calculate grid around current price using ATR', () => {
      const params = calculateGridParams({
        currentPrice: 60000,
        atr14: 1500,
        capital: 10000,
      });

      expect(params.lowerBound).toBe(60000 - 1500 * 3);
      expect(params.upperBound).toBe(60000 + 1500 * 3);
      expect(params.levelsCount).toBeGreaterThanOrEqual(5);
      expect(params.levelsCount).toBeLessThanOrEqual(30);
      expect(params.levels.length).toBe(params.levelsCount + 1);
    });

    it('should produce levels sorted ascending', () => {
      const params = calculateGridParams({
        currentPrice: 60000,
        atr14: 1500,
        capital: 10000,
      });

      for (let i = 1; i < params.levels.length; i++) {
        expect(params.levels[i]).toBeGreaterThan(params.levels[i - 1]);
      }
    });

    it('should widen step for high volatility', () => {
      const normal = calculateGridParams(
        { currentPrice: 60000, atr14: 1500, capital: 10000 },
        2.5, // avg ATR %
      );
      const high = calculateGridParams(
        { currentPrice: 60000, atr14: 3000, capital: 10000 },
        2.5,
      );

      expect(high.gridStepPct).toBeGreaterThan(normal.gridStepPct);
    });

    it('should narrow step for low volatility', () => {
      const normal = calculateGridParams(
        { currentPrice: 60000, atr14: 1500, capital: 10000 },
        2.5,
      );
      const low = calculateGridParams(
        { currentPrice: 60000, atr14: 500, capital: 10000 },
        2.5,
      );

      expect(low.gridStepPct).toBeLessThan(normal.gridStepPct);
    });
  });

  // --- classifyVolatility ---
  describe('classifyVolatility', () => {
    it('should classify high volatility', () => {
      expect(classifyVolatility(5.0, 2.5)).toBe('high');
    });

    it('should classify low volatility', () => {
      expect(classifyVolatility(1.0, 2.5)).toBe('low');
    });

    it('should classify normal volatility', () => {
      expect(classifyVolatility(2.5, 2.5)).toBe('normal');
    });
  });

  // --- generateGridOrders ---
  describe('generateGridOrders', () => {
    it('should create buy orders below and sell orders above current price', () => {
      const params = calculateGridParams({
        currentPrice: 60000,
        atr14: 1500,
        capital: 10000,
      });
      const orders = generateGridOrders(params, 60000, 500);

      const buys = orders.filter((o) => o.side === 'buy');
      const sells = orders.filter((o) => o.side === 'sell');

      expect(buys.length).toBeGreaterThan(0);
      expect(sells.length).toBeGreaterThan(0);

      buys.forEach((o) => expect(o.price).toBeLessThan(60000));
      sells.forEach((o) => expect(o.price).toBeGreaterThanOrEqual(60000));
    });

    it('should set all orders to pending', () => {
      const params = calculateGridParams({
        currentPrice: 60000,
        atr14: 1500,
        capital: 10000,
      });
      const orders = generateGridOrders(params, 60000, 500);
      orders.forEach((o) => expect(o.status).toBe('pending'));
    });
  });

  // --- capitalPerLevel ---
  describe('calculateCapitalPerLevel', () => {
    it('should allocate 60% of capital by default', () => {
      const perLevel = calculateCapitalPerLevel(10000, 10);
      expect(perLevel).toBe(600); // 10000 * 0.6 / 10
    });

    it('should respect custom active capital percentage', () => {
      const perLevel = calculateCapitalPerLevel(10000, 10, 80);
      expect(perLevel).toBe(800);
    });
  });

  // --- Grid cycle: buy → sell ---
  describe('onBuyFilled', () => {
    it('should generate sell order above buy price', () => {
      const result = onBuyFilled(
        {
          levelIndex: 3,
          price: 59000,
          side: 'buy',
          quantity: 0.01,
          status: 'filled',
        },
        1.25,
      );

      expect(result.side).toBe('sell');
      expect(result.price).toBeGreaterThan(59000);
      expect(result.price).toBeCloseTo(59000 * 1.0125, 0);
      expect(result.quantity).toBe(0.01);
    });
  });

  describe('onSellFilled', () => {
    it('should generate buy order below sell price', () => {
      const result = onSellFilled(
        {
          levelIndex: 7,
          price: 61000,
          side: 'sell',
          quantity: 0.01,
          status: 'filled',
        },
        1.25,
      );

      expect(result.side).toBe('buy');
      expect(result.price).toBeLessThan(61000);
      expect(result.quantity).toBe(0.01);
    });
  });

  // --- PnL ---
  describe('calculateCyclePnl', () => {
    it('should calculate profit minus fees', () => {
      // Buy at 59000, sell at 60000, qty 0.01
      const pnl = calculateCyclePnl(59000, 60000, 0.01, 0.001);
      const gross = (60000 - 59000) * 0.01; // 10
      const fees = 59000 * 0.01 * 0.001 + 60000 * 0.01 * 0.001; // 0.59 + 0.60 = 1.19
      expect(pnl).toBeCloseTo(gross - fees, 1);
    });

    it('should return negative for small price movement eaten by fees', () => {
      const pnl = calculateCyclePnl(60000, 60050, 0.01, 0.001);
      expect(pnl).toBeLessThan(0.5); // barely break even
    });
  });

  // --- isPriceInGrid ---
  describe('isPriceInGrid', () => {
    it('returns true when price is inside', () => {
      expect(isPriceInGrid(60000, 55000, 65000)).toBe(true);
    });

    it('returns false when price is outside', () => {
      expect(isPriceInGrid(70000, 55000, 65000)).toBe(false);
      expect(isPriceInGrid(50000, 55000, 65000)).toBe(false);
    });
  });

  // --- priceDeviationFromGrid ---
  describe('priceDeviationFromGrid', () => {
    it('returns 0 when inside', () => {
      expect(priceDeviationFromGrid(60000, 55000, 65000)).toBe(0);
    });

    it('returns positive deviation when above', () => {
      const dev = priceDeviationFromGrid(66000, 55000, 65000);
      expect(dev).toBeGreaterThan(0);
      expect(dev).toBeCloseTo(((66000 - 65000) / 65000) * 100, 1);
    });

    it('returns positive deviation when below', () => {
      const dev = priceDeviationFromGrid(54000, 55000, 65000);
      expect(dev).toBeGreaterThan(0);
    });
  });

  // --- Rebalance triggers ---
  describe('checkRebalanceTriggers', () => {
    it('returns price_upper_zone when price in upper 20% for 4h+', () => {
      const trigger = checkRebalanceTriggers(
        64500, // near upper bound
        55000,
        65000,
        2.5,
        2.5,
        5, // 5 hours in upper zone
        0,
      );
      expect(trigger).toBe('price_upper_zone');
    });

    it('returns atr_increase when ATR spikes', () => {
      const trigger = checkRebalanceTriggers(
        60000,
        55000,
        65000,
        5.0, // current ATR %
        2.5, // avg
        0,
        0,
      );
      expect(trigger).toBe('atr_increase');
    });

    it('returns null when nothing triggers', () => {
      const trigger = checkRebalanceTriggers(
        60000,
        55000,
        65000,
        2.5,
        2.5,
        0,
        0,
      );
      expect(trigger).toBeNull();
    });
  });

  // --- calculateRebalance ---
  describe('calculateRebalance', () => {
    it('should recenter grid on price_upper_zone', () => {
      const result = calculateRebalance(
        'price_upper_zone',
        64000,
        1500,
        1.25,
        2.5,
      );
      expect(result.newLowerBound).toBeCloseTo(64000 - 4500, 0);
      expect(result.newUpperBound).toBeCloseTo(64000 + 4500, 0);
      expect(result.newGridStepPct).toBe(1.25); // keeps current step
    });

    it('should widen step on atr_increase', () => {
      const result = calculateRebalance(
        'atr_increase',
        60000,
        3000, // high ATR
        1.25,
        2.5,
      );
      expect(result.newGridStepPct).toBeGreaterThan(1.25);
    });
  });
});
