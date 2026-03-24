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

const MIN_LEVELS = 2;
const MAX_LEVELS = 30;
const MIN_ORDER_NOTIONAL_USDT = 11; // Binance minimum is $10 for SOL/USDT, use $11 for safety

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
  const gridStepPct = calculateGridStep(volatility);

  const lowerBound = currentPrice - atr14 * atrMultiplier;
  const upperBound = currentPrice + atr14 * atrMultiplier;

  const rangeSize = upperBound - lowerBound;
  const stepAbsolute = currentPrice * (gridStepPct / 100);
  let levelsCount = Math.floor(rangeSize / stepAbsolute);

  // Cap levels by minimum notional constraint if capital is provided
  const capitalLimit = capital ? calculateMaxLevels(capital) : MAX_LEVELS;
  levelsCount = Math.max(
    MIN_LEVELS,
    Math.min(MAX_LEVELS, capitalLimit, levelsCount),
  );

  const actualStep = rangeSize / levelsCount;
  const levels: number[] = [];
  for (let i = 0; i <= levelsCount; i++) {
    levels.push(roundPrice(lowerBound + actualStep * i));
  }

  return {
    lowerBound: roundPrice(lowerBound),
    upperBound: roundPrice(upperBound),
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
 */
export function calculateMaxLevels(
  activeCapital: number,
  minNotional: number = MIN_ORDER_NOTIONAL_USDT,
): number {
  return Math.max(MIN_LEVELS, Math.floor(activeCapital / minNotional));
}

// --- Grid cycle logic ---

export function onBuyFilled(
  filledOrder: GridOrder,
  gridStepPct: number,
): GridLevel {
  const sellPrice = filledOrder.price * (1 + gridStepPct / 100);
  return {
    price: roundPrice(sellPrice),
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
  const upperZoneThreshold = upperBound - range * 0.2;
  const lowerZoneThreshold = lowerBound + range * 0.2;

  if (currentPrice > upperZoneThreshold && hoursInUpperZone >= 4) {
    return 'price_upper_zone';
  }

  if (currentPrice < lowerZoneThreshold && hoursInLowerZone >= 4) {
    return 'price_lower_zone';
  }

  if (currentAtrPct > avgAtrPct * 1.5) {
    return 'atr_increase';
  }

  if (currentAtrPct < avgAtrPct * 0.3) {
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
