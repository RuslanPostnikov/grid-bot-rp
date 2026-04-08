import type {
  GridParams,
  GridInput,
  GridLevel,
  GridOrder,
  MarketVolatility,
  RebalanceResult,
  RebalanceTrigger,
} from './grid.types.js';

// --- Grid parameter calculation ---

const STEP_BY_VOLATILITY: Record<
  MarketVolatility,
  { min: number; max: number }
> = {
  low: { min: 0.5, max: 0.8 },
  normal: { min: 1.0, max: 1.5 },
  high: { min: 2.0, max: 2.5 },
};

const ATR_MULTIPLIER_BY_VOLATILITY: Record<MarketVolatility, number> = {
  low: 2, // calm market → tight grid → more fills
  normal: 3, // standard
  high: 4, // volatile market → wide grid → price stays in range
};

const MAX_LEVELS = 30;
const MIN_ORDER_NOTIONAL_USDT = 6; // Binance minimum is $5 for SOL/USDT, use $6 for safety

export function classifyVolatility(
  atrPct: number,
  avgAtrPct: number,
): MarketVolatility {
  if (atrPct > avgAtrPct * 1.5) return 'high';
  if (atrPct < avgAtrPct * 0.5) return 'low';
  return 'normal';
}

export function calculateAtrMultiplier(volatility: MarketVolatility): number {
  return ATR_MULTIPLIER_BY_VOLATILITY[volatility];
}

export function calculateGridStep(volatility: MarketVolatility): number {
  const range = STEP_BY_VOLATILITY[volatility];
  return (range.min + range.max) / 2;
}

export function calculateGridParams(
  input: GridInput,
  avgAtrPct?: number,
): GridParams {
  const { currentPrice, atr14, capital } = input;

  const atrPct = (atr14 / currentPrice) * 100;
  const effectiveAvgAtrPct = avgAtrPct ?? atrPct;
  const volatility = classifyVolatility(atrPct, effectiveAvgAtrPct);
  const atrMultiplier = calculateAtrMultiplier(volatility);
  let gridStepPct = calculateGridStep(volatility);

  const lowerBound = currentPrice - atr14 * atrMultiplier;
  const upperBound = currentPrice + atr14 * atrMultiplier;

  // Cap levels by minimum notional constraint if capital is provided.
  const capitalLimit = capital ? calculateMaxLevels(capital) : MAX_LEVELS;
  const effectiveLimit = Math.max(1, capitalLimit);

  // Adaptive step sizing: when capital only allows few levels,
  // increase step to make each trade more profitable
  if (effectiveLimit <= 3) {
    gridStepPct = Math.max(gridStepPct, 3.0);
  } else if (effectiveLimit <= 5) {
    gridStepPct = Math.max(gridStepPct, 2.0);
  }

  // Fix 2.3: enforce absolute floor on step so fees + slippage can't eat profit.
  gridStepPct = Math.max(gridStepPct, ABSOLUTE_MIN_STEP_PCT);

  const stepAbsolute = currentPrice * (gridStepPct / 100);
  const rangeLevels = Math.floor((upperBound - lowerBound) / stepAbsolute);
  const levelsCount = Math.max(
    1,
    Math.min(MAX_LEVELS, effectiveLimit, rangeLevels),
  );

  // Ensure minimum grid width of 2×ATR so the grid isn't too narrow
  const minHalfRange = atr14;
  const actualStep = stepAbsolute;
  const calculatedHalfRange = (actualStep * levelsCount) / 2;
  const halfRange = Math.max(calculatedHalfRange, minHalfRange);
  const effectiveLower = roundPrice(
    Math.max(lowerBound, currentPrice - halfRange),
  );
  const effectiveUpper = roundPrice(
    Math.max(
      effectiveLower + actualStep * levelsCount,
      currentPrice + halfRange,
    ),
  );

  const levels: number[] = [];
  for (let i = 0; i <= levelsCount; i++) {
    levels.push(roundPrice(effectiveLower + actualStep * i));
  }

  return {
    lowerBound: effectiveLower,
    upperBound: effectiveUpper,
    gridStepPct: roundPct((actualStep / currentPrice) * 100),
    levelsCount,
    levels,
  };
}

// --- Grid levels and orders ---

export function generateGridOrders(
  params: GridParams,
  currentPrice: number,
  capitalPerLevel: number,
): GridOrder[] {
  const orders: GridOrder[] = [];

  for (let i = 0; i < params.levels.length; i++) {
    const price = params.levels[i];
    const side = price < currentPrice ? 'buy' : 'sell';
    const quantity = capitalPerLevel / price;

    orders.push({
      levelIndex: i,
      price,
      side,
      quantity: roundQuantity(quantity),
      status: 'pending',
    });
  }

  return orders;
}

export function calculateCapitalPerLevel(
  activeCapital: number,
  levelsCount: number,
): number {
  return activeCapital / levelsCount;
}

/**
 * Calculate max levels that satisfy minimum notional per order.
 * Returns 0 if capital is insufficient for even one order.
 */
export function calculateMaxLevels(
  activeCapital: number,
  minNotional: number = MIN_ORDER_NOTIONAL_USDT,
): number {
  return Math.floor(activeCapital / minNotional);
}

// --- Grid cycle logic ---

// Fix 2.3: minimum profit per cycle must cover 4× fee plus slippage margin.
// Old logic used 2× fee (just enough to break even), but slippage and partial
// fills regularly ate into that, producing 0-PnL or slightly negative trades.
// New formula: feeRate × 400 (4× round-trip) + 0.2% slippage buffer.
// Floor of 0.6% prevents step from collapsing on very low fee rates.
const ABSOLUTE_MIN_STEP_PCT = 0.6;

export function calculateMinProfitPct(feeRate: number): number {
  return Math.max(ABSOLUTE_MIN_STEP_PCT, feeRate * 400 + 0.2);
}

export function onBuyFilled(
  filledOrder: GridOrder,
  gridStepPct: number,
  currentPrice: number,
  upperBound: number,
  feeRate: number = 0.001,
): GridLevel {
  // Minimum step must cover 4× fee + slippage buffer
  const minStepPct = Math.max(gridStepPct, calculateMinProfitPct(feeRate));

  // Ensure the counter-sell is placed above current market price, not just above fill price.
  // This prevents immediately-filling limit sells when a buy executes below the active grid range.
  const sellByFill = filledOrder.price * (1 + minStepPct / 100);
  const sellByMarket = currentPrice * (1 + minStepPct / 100);
  const sellPrice = Math.max(sellByFill, sellByMarket);

  // Cap at upper bound to avoid placing an order that may never fill.
  const cappedPrice = Math.min(sellPrice, upperBound);

  return {
    price: roundPrice(cappedPrice),
    side: 'sell',
    quantity: filledOrder.quantity,
  };
}

export function onSellFilled(
  filledOrder: GridOrder,
  gridStepPct: number,
): GridLevel {
  const buyPrice = filledOrder.price * (1 - gridStepPct / 100);
  return {
    price: roundPrice(buyPrice),
    side: 'buy',
    quantity: filledOrder.quantity,
  };
}

export function calculateCyclePnl(
  buyPrice: number,
  sellPrice: number,
  quantity: number,
  feeRate: number = 0.001,
): number {
  const buyTotal = buyPrice * quantity;
  const sellTotal = sellPrice * quantity;
  const buyFee = buyTotal * feeRate;
  const sellFee = sellTotal * feeRate;
  return roundPrice(sellTotal - buyTotal - buyFee - sellFee);
}

// --- Rebalance logic ---

export function checkRebalanceTriggers(
  currentPrice: number,
  lowerBound: number,
  upperBound: number,
  currentAtrPct: number,
  avgAtrPct: number,
  hoursInUpperZone: number,
  hoursInLowerZone: number,
): RebalanceTrigger | null {
  const range = upperBound - lowerBound;
  // Fix 2.2: tighter zone (20% instead of 35%) — only act on real boundary
  // approach, not routine fluctuations. Combined with 2h cooldown to cut
  // 88% cancel rate.
  const upperZoneThreshold = upperBound - range * 0.2;
  const lowerZoneThreshold = lowerBound + range * 0.2;

  // Require 8 hours in zone to avoid premature rebalances
  if (currentPrice > upperZoneThreshold && hoursInUpperZone >= 8) {
    return 'price_upper_zone';
  }

  if (currentPrice < lowerZoneThreshold && hoursInLowerZone >= 8) {
    return 'price_lower_zone';
  }

  if (currentAtrPct > avgAtrPct * 1.5) {
    return 'atr_increase';
  }

  // Fix 2.2: stricter atr_decrease threshold (×0.2 instead of ×0.3) — only
  // rebalance on a really sharp volatility drop, not minor calming.
  if (currentAtrPct < avgAtrPct * 0.2) {
    return 'atr_decrease';
  }

  return null;
}

export function calculateRebalance(
  trigger: RebalanceTrigger,
  currentPrice: number,
  atr14: number,
  currentStepPct: number,
  avgAtrPct: number,
): RebalanceResult {
  const atrPct = (atr14 / currentPrice) * 100;
  const volatility = classifyVolatility(atrPct, avgAtrPct);
  const atrMultiplier = calculateAtrMultiplier(volatility);

  switch (trigger) {
    case 'price_upper_zone':
    case 'time_24h': {
      return {
        trigger,
        newLowerBound: roundPrice(currentPrice - atr14 * atrMultiplier),
        newUpperBound: roundPrice(currentPrice + atr14 * atrMultiplier),
        newGridStepPct: currentStepPct,
      };
    }
    case 'price_lower_zone': {
      return {
        trigger,
        newLowerBound: roundPrice(currentPrice - atr14 * atrMultiplier),
        newUpperBound: roundPrice(currentPrice + atr14 * atrMultiplier),
        newGridStepPct: currentStepPct,
      };
    }
    case 'atr_increase': {
      const newVolatility = classifyVolatility(atrPct, avgAtrPct);
      return {
        trigger,
        newLowerBound: roundPrice(
          currentPrice - atr14 * calculateAtrMultiplier(newVolatility),
        ),
        newUpperBound: roundPrice(
          currentPrice + atr14 * calculateAtrMultiplier(newVolatility),
        ),
        newGridStepPct: calculateGridStep(newVolatility),
      };
    }
    case 'atr_decrease': {
      const newVolatility = classifyVolatility(atrPct, avgAtrPct);
      return {
        trigger,
        newLowerBound: roundPrice(
          currentPrice - atr14 * calculateAtrMultiplier(newVolatility),
        ),
        newUpperBound: roundPrice(
          currentPrice + atr14 * calculateAtrMultiplier(newVolatility),
        ),
        newGridStepPct: calculateGridStep(newVolatility),
      };
    }
  }
}

// --- Price helpers ---

export function isPriceInGrid(
  price: number,
  lowerBound: number,
  upperBound: number,
): boolean {
  return price >= lowerBound && price <= upperBound;
}

export function priceDeviationFromGrid(
  price: number,
  lowerBound: number,
  upperBound: number,
): number {
  if (price < lowerBound) {
    return roundPct(((lowerBound - price) / lowerBound) * 100);
  }
  if (price > upperBound) {
    return roundPct(((price - upperBound) / upperBound) * 100);
  }
  return 0;
}

// --- Rounding ---

function roundPrice(n: number): number {
  return Math.round(n * 100) / 100;
}

function roundPct(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function roundQuantity(n: number): number {
  return Math.round(n * 100000) / 100000;
}
