import type {
  OHLCV,
  BacktestConfig,
  BacktestResult,
  SimOrder,
  SimTrade,
} from './types.js';
import { calculateATR } from './indicators.js';

export function runBacktest(
  candles: OHLCV[],
  config: BacktestConfig,
): BacktestResult {
  const {
    initialCapital,
    activeCapitalPct,
    gridStepPct,
    atrPeriod,
    atrMultiplier,
    feeRate,
    slippagePct,
    rebalanceIntervalCandles,
  } = config;

  const atrValues = calculateATR(candles, atrPeriod);
  // ATR array is offset: atrValues[0] corresponds to candle[atrPeriod]
  const startIdx = atrPeriod + 1; // first candle where we have ATR

  if (startIdx >= candles.length) {
    throw new Error(
      `Not enough candles (${candles.length}) for ATR period (${atrPeriod})`,
    );
  }

  // State
  let cashBalance = initialCapital;
  let coinBalance = 0;
  const trades: SimTrade[] = [];
  let totalFees = 0;
  let totalRebalances = 0;
  let timesOutOfRange = 0;
  let candlesSinceRebalance = 0;

  // Grid state
  let gridOrders: SimOrder[] = [];
  let lowerBound = 0;
  let upperBound = 0;

  // Equity tracking
  const equityCurve: { timestamp: number; equity: number }[] = [];
  let peakEquity = initialCapital;
  let maxDrawdown = 0;

  // Daily returns for Sharpe
  const dailyReturns: number[] = [];
  let prevEquity = initialCapital;
  let candlesPerDay = 0;

  // Determine candles per day from timeframe
  if (candles.length >= 2) {
    const diffMs = candles[1].timestamp - candles[0].timestamp;
    const hoursPerCandle = diffMs / (1000 * 60 * 60);
    candlesPerDay = Math.round(24 / hoursPerCandle);
  }

  function getEquity(price: number): number {
    return cashBalance + coinBalance * price;
  }

  function setupGrid(price: number, atr: number): void {
    lowerBound = price - atr * atrMultiplier;
    upperBound = price + atr * atrMultiplier;

    const activeCapital = cashBalance * (activeCapitalPct / 100);
    const range = upperBound - lowerBound;
    const stepAbsolute = price * (gridStepPct / 100);
    const levelsCount = Math.max(
      5,
      Math.min(30, Math.floor(range / stepAbsolute)),
    );
    const actualStep = range / levelsCount;
    const capitalPerLevel = activeCapital / levelsCount;

    gridOrders = [];
    for (let i = 0; i <= levelsCount; i++) {
      const levelPrice = lowerBound + actualStep * i;
      if (levelPrice <= 0) continue;

      const side = levelPrice < price ? 'buy' : 'sell';
      const quantity = capitalPerLevel / levelPrice;

      gridOrders.push({
        price: levelPrice,
        side,
        quantity,
        placedAt: 0,
      });
    }
  }

  function applySlippage(price: number, side: 'buy' | 'sell'): number {
    const slip = price * (slippagePct / 100);
    return side === 'buy' ? price + slip : price - slip;
  }

  // --- Main loop ---

  for (let i = startIdx; i < candles.length; i++) {
    const candle = candles[i];
    const atrIdx = i - atrPeriod - 1;
    const atr = atrValues[atrIdx] ?? atrValues[atrValues.length - 1];

    // Initialize grid on first candle
    if (gridOrders.length === 0) {
      setupGrid(candle.open, atr);
      totalRebalances++;
    }

    // Check if price is out of range
    if (candle.low < lowerBound || candle.high > upperBound) {
      timesOutOfRange++;
    }

    // Check fills: iterate through candle's price range
    const fillsThisCandle: SimOrder[] = [];

    for (const order of gridOrders) {
      if (order.side === 'buy' && candle.low <= order.price) {
        fillsThisCandle.push(order);
      } else if (order.side === 'sell' && candle.high >= order.price) {
        fillsThisCandle.push(order);
      }
    }

    // Process fills
    for (const filled of fillsThisCandle) {
      const execPrice = applySlippage(filled.price, filled.side);
      const fee = execPrice * filled.quantity * feeRate;
      totalFees += fee;

      if (filled.side === 'buy') {
        cashBalance -= execPrice * filled.quantity + fee;
        coinBalance += filled.quantity;

        // Place matching sell order above
        const sellPrice = filled.price * (1 + gridStepPct / 100);
        gridOrders.push({
          price: sellPrice,
          side: 'sell',
          quantity: filled.quantity,
          placedAt: i,
        });
      } else {
        // sell
        cashBalance += execPrice * filled.quantity - fee;
        coinBalance -= filled.quantity;

        // Find matching buy to calculate PnL
        const buyPrice = filled.price * (1 - gridStepPct / 100);
        const buyFee = buyPrice * filled.quantity * feeRate;
        const sellFee = fee;
        const pnl =
          execPrice * filled.quantity -
          buyPrice * filled.quantity -
          buyFee -
          sellFee;

        trades.push({
          buyPrice,
          sellPrice: execPrice,
          quantity: filled.quantity,
          buyFee,
          sellFee,
          pnl,
          closedAt: candle.timestamp,
        });

        // Place matching buy order below
        gridOrders.push({
          price: buyPrice,
          side: 'buy',
          quantity: filled.quantity,
          placedAt: i,
        });
      }
    }

    // Remove filled orders
    gridOrders = gridOrders.filter((o) => !fillsThisCandle.includes(o));

    // Rebalance check
    candlesSinceRebalance++;
    if (candlesSinceRebalance >= rebalanceIntervalCandles) {
      setupGrid(candle.close, atr);
      totalRebalances++;
      candlesSinceRebalance = 0;
    }

    // Track equity
    const equity = getEquity(candle.close);
    equityCurve.push({ timestamp: candle.timestamp, equity });

    // Max drawdown
    if (equity > peakEquity) peakEquity = equity;
    const drawdown = peakEquity - equity;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    // Daily returns
    if (candlesPerDay > 0 && (i - startIdx) % candlesPerDay === 0 && i > startIdx) {
      dailyReturns.push((equity - prevEquity) / prevEquity);
      prevEquity = equity;
    }
  }

  // --- Calculate results ---

  const lastCandle = candles[candles.length - 1];
  const firstCandle = candles[startIdx];
  const finalEquity = getEquity(lastCandle.close);

  const totalPnl = finalEquity - initialCapital;
  const totalPnlPct = (totalPnl / initialCapital) * 100;
  const netPnl = totalPnl; // fees already deducted from cash
  const netPnlPct = totalPnlPct;

  const profitableCycles = trades.filter((t) => t.pnl > 0).length;
  const winRate = trades.length > 0 ? profitableCycles / trades.length : 0;
  const avgProfit =
    trades.length > 0
      ? trades.reduce((s, t) => s + t.pnl, 0) / trades.length
      : 0;

  // HODL
  const hodlCoins = initialCapital / firstCandle.open;
  const hodlFinal = hodlCoins * lastCandle.close;
  const hodlPnl = hodlFinal - initialCapital;
  const hodlPnlPct = (hodlPnl / initialCapital) * 100;

  // Sharpe (annualized, 365 days)
  const sharpeRatio = calculateSharpe(dailyReturns, 365);

  // Sample equity curve (max 500 points)
  const sampleInterval = Math.max(1, Math.floor(equityCurve.length / 500));
  const sampledCurve = equityCurve.filter((_, idx) => idx % sampleInterval === 0);

  return {
    config,
    totalCandles: candles.length,
    periodStart: new Date(firstCandle.timestamp).toISOString(),
    periodEnd: new Date(lastCandle.timestamp).toISOString(),
    startPrice: firstCandle.open,
    endPrice: lastCandle.close,

    totalPnl: round(totalPnl),
    totalPnlPct: round(totalPnlPct),
    totalFees: round(totalFees),
    netPnl: round(netPnl),
    netPnlPct: round(netPnlPct),

    totalCycles: trades.length,
    profitableCycles,
    winRate: round(winRate * 100),
    avgProfitPerCycle: round(avgProfit),

    maxDrawdown: round(maxDrawdown),
    maxDrawdownPct: round((maxDrawdown / peakEquity) * 100),

    sharpeRatio: round(sharpeRatio),

    hodlPnl: round(hodlPnl),
    hodlPnlPct: round(hodlPnlPct),
    vsHodl: round(totalPnl - hodlPnl),

    totalRebalances,
    timesOutOfRange,

    equityCurve: sampledCurve,
  };
}

function calculateSharpe(
  dailyReturns: number[],
  annualizationFactor: number,
): number {
  if (dailyReturns.length < 2) return 0;

  const mean =
    dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
  const variance =
    dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) /
    (dailyReturns.length - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return 0;
  return (mean / stdDev) * Math.sqrt(annualizationFactor);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// --- Parameter optimization ---

export function runOptimization(
  candles: OHLCV[],
  baseConfig: BacktestConfig,
  stepPcts: number[] = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5],
): { stepPct: number; result: BacktestResult }[] {
  return stepPcts.map((stepPct) => {
    const config = { ...baseConfig, gridStepPct: stepPct };
    const result = runBacktest(candles, config);
    return { stepPct, result };
  });
}
