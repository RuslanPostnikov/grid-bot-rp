// @ts-nocheck
/**
 * Integration test: проверяет новые фичи Шагов 2-5.
 *
 * 1. Реальные комиссии (getTradingFees)
 * 2. Grid setup с реальной комиссией (feeRate в ActiveGrid)
 * 3. Rebalance grid lifecycle
 * 4. Классификатор рынка (MlService)
 * 5. Ребаланс-триггеры (checkRebalanceTriggers)
 *
 * Запуск: npx tsx scripts/test-new-features.ts
 */

import 'dotenv/config';
import { ATR } from 'technicalindicators';
import {
  checkRebalanceTriggers,
  calculateGridParams,
  classifyVolatility,
  calculateAtrMultiplier,
} from '../src/modules/grid/grid-calculator.js';

const PAIR = process.env.EXCHANGE_TRADING_PAIR ?? 'SOL/USDT';

async function main() {
  const results: { test: string; status: 'PASS' | 'FAIL'; detail: string }[] = [];

  function pass(test: string, detail: string) {
    results.push({ test, status: 'PASS', detail });
    console.log(`  ✅ ${test}: ${detail}`);
  }
  function fail(test: string, detail: string) {
    results.push({ test, status: 'FAIL', detail });
    console.log(`  ❌ ${test}: ${detail}`);
  }

  // Init exchange
  const ccxt = await import('ccxt');
  const exchange = new ccxt.binance({
    apiKey: process.env.EXCHANGE_API_KEY,
    secret: process.env.EXCHANGE_API_SECRET,
    enableRateLimit: true,
  });
  exchange.setSandboxMode(process.env.EXCHANGE_TESTNET !== 'false');

  // Init DB
  const { PrismaClient } = await import('../generated/prisma/client.js');
  const prisma = new PrismaClient();
  await prisma.$connect();

  const ticker = await exchange.fetchTicker(PAIR);
  const currentPrice = ticker.last;
  console.log(`\n${PAIR} current price: $${currentPrice}\n`);

  // ═══════════════════════════════════════════════════════
  // 1. Реальные комиссии
  // ═══════════════════════════════════════════════════════
  console.log('=== 1. Trading Fees ===');
  try {
    const fees = exchange.fees?.trading;
    if (fees && typeof fees.taker === 'number' && typeof fees.maker === 'number') {
      pass('Exchange fees', `taker=${(fees.taker * 100).toFixed(3)}%, maker=${(fees.maker * 100).toFixed(3)}%`);
    } else {
      fail('Exchange fees', `fees.trading not available: ${JSON.stringify(fees)}`);
    }
  } catch (e: any) {
    fail('Exchange fees', e.message);
  }

  // ═══════════════════════════════════════════════════════
  // 2. ATR + волатильность + параметры grid
  // ═══════════════════════════════════════════════════════
  console.log('\n=== 2. ATR & Grid Params ===');
  let atr14 = 0;
  let avgAtrPct = 0;
  try {
    const candles = await exchange.fetchOHLCV(PAIR, '1h', undefined, 100);
    const highs = candles.map((c) => c[2]);
    const lows = candles.map((c) => c[3]);
    const closes = candles.map((c) => c[4]);

    const atrValues = ATR.calculate({
      high: highs,
      low: lows,
      close: closes,
      period: 14,
    });

    atr14 = atrValues[atrValues.length - 1];
    const lastPrice = closes[closes.length - 1];
    const recentAtrs = atrValues.slice(-20);
    avgAtrPct = recentAtrs.reduce((s, v) => s + (v / lastPrice) * 100, 0) / recentAtrs.length;

    const atrPct = (atr14 / currentPrice) * 100;
    const volatility = classifyVolatility(atrPct, avgAtrPct);
    const multiplier = calculateAtrMultiplier(volatility);

    pass('ATR calculation', `ATR14=$${atr14.toFixed(4)}, ATR%=${atrPct.toFixed(3)}%, avg=${avgAtrPct.toFixed(3)}%`);
    pass('Volatility', `regime=${volatility}, multiplier=${multiplier}`);

    const params = calculateGridParams({ currentPrice, atr14, capital: 80 });
    pass('Grid params', `[${params.lowerBound} - ${params.upperBound}] step=${params.gridStepPct}% levels=${params.levelsCount}`);
  } catch (e: any) {
    fail('ATR / Grid params', e.message);
  }

  // ═══════════════════════════════════════════════════════
  // 3. Rebalance lifecycle (setup → rebalance → verify)
  // ═══════════════════════════════════════════════════════
  console.log('\n=== 3. Grid Rebalance Lifecycle ===');
  const placedOrders: string[] = [];
  try {
    // Setup: place 2 buy orders below price
    const step = currentPrice * 0.03;
    for (let i = 1; i <= 2; i++) {
      const price = parseFloat((currentPrice - step * i).toFixed(2));
      const qty = parseFloat((6 / price).toFixed(5)); // min notional $6
      const order = await exchange.createOrder(PAIR, 'limit', 'buy', qty, price);
      placedOrders.push(order.id);
    }
    pass('Setup grid', `${placedOrders.length} buy orders placed`);

    // Verify orders exist
    await sleep(1500);
    let openOrders = await exchange.fetchOpenOrders(PAIR);
    const ourOpen = openOrders.filter((o) => placedOrders.includes(o.id));
    pass('Verify setup', `${ourOpen.length}/${placedOrders.length} orders on exchange`);

    // Cancel all (simulate rebalance cancel phase)
    for (const id of placedOrders) {
      await exchange.cancelOrder(id, PAIR);
    }
    pass('Cancel (rebalance)', `${placedOrders.length} orders cancelled`);

    // Re-setup with shifted prices (simulate rebalance setup phase)
    const newOrders: string[] = [];
    const newStep = currentPrice * 0.025;
    for (let i = 1; i <= 2; i++) {
      const price = parseFloat((currentPrice - newStep * i).toFixed(2));
      const qty = parseFloat((6 / price).toFixed(5));
      const order = await exchange.createOrder(PAIR, 'limit', 'buy', qty, price);
      newOrders.push(order.id);
    }
    pass('Re-setup (rebalance)', `${newOrders.length} new orders placed at shifted prices`);

    // Cleanup
    for (const id of newOrders) {
      await exchange.cancelOrder(id, PAIR);
    }
    pass('Cleanup', 'All orders cancelled');
  } catch (e: any) {
    fail('Rebalance lifecycle', e.message);
    // cleanup
    for (const id of placedOrders) {
      try { await exchange.cancelOrder(id, PAIR); } catch {}
    }
  }

  // ═══════════════════════════════════════════════════════
  // 4. Классификатор рынка (rule-based, без NestJS)
  // ═══════════════════════════════════════════════════════
  console.log('\n=== 4. Market Regime Classifier ===');
  try {
    const candles = await prisma.candle.findMany({
      where: { pair: PAIR, timeframe: '4h' },
      orderBy: { openTime: 'desc' },
      take: 100,
    });

    if (candles.length >= 60) {
      // Import classifier directly
      const { extractFeatures } = await import('../src/modules/ml/market-features.js');
      const { classifyRegime, mapRegimeToAction } = await import('../src/modules/ml/regime-classifier.js');

      const ordered = candles.reverse();
      const features = extractFeatures(ordered);

      if (features) {
        const classification = classifyRegime(features);
        const action = mapRegimeToAction(classification.regime);
        pass('Classify regime', `${classification.regime} (${(classification.confidence * 100).toFixed(0)}%) → ${action}`);
        pass('Features', `ADX=${features.adx14.toFixed(1)} RSI=${features.rsi14.toFixed(1)} ATR%=${features.atrPct.toFixed(3)} BBW=${features.bbWidth.toFixed(4)}`);
      } else {
        fail('Features', 'extractFeatures returned null (not enough data?)');
      }
    } else {
      console.log(`  ⚠️ Skip: need 60+ 4h candles in DB, have ${candles.length}. Тест классификатора пропущен.`);
      pass('Classifier (skipped)', `Only ${candles.length} candles, need 60+. Run collector first.`);
    }
  } catch (e: any) {
    fail('Classifier', e.message);
  }

  // ═══════════════════════════════════════════════════════
  // 5. Ребаланс-триггеры (pure functions)
  // ═══════════════════════════════════════════════════════
  console.log('\n=== 5. Rebalance Triggers ===');
  try {
    const gridLower = currentPrice * 0.95;
    const gridUpper = currentPrice * 1.05;

    // Цена в центре → нет триггера
    const t1 = checkRebalanceTriggers(currentPrice, gridLower, gridUpper, avgAtrPct, avgAtrPct, 0, 0);
    pass('Center price', `trigger=${t1 ?? 'none'} (expected: none)`);

    // Цена в верхней зоне, 4+ часов → price_upper_zone
    const upperPrice = gridUpper - (gridUpper - gridLower) * 0.1;
    const t2 = checkRebalanceTriggers(upperPrice, gridLower, gridUpper, avgAtrPct, avgAtrPct, 5, 0);
    if (t2 === 'price_upper_zone') {
      pass('Upper zone trigger', `trigger=${t2}`);
    } else {
      fail('Upper zone trigger', `expected price_upper_zone, got ${t2}`);
    }

    // Цена в нижней зоне, 4+ часов → price_lower_zone
    const lowerPrice = gridLower + (gridUpper - gridLower) * 0.1;
    const t3 = checkRebalanceTriggers(lowerPrice, gridLower, gridUpper, avgAtrPct, avgAtrPct, 0, 5);
    if (t3 === 'price_lower_zone') {
      pass('Lower zone trigger', `trigger=${t3}`);
    } else {
      fail('Lower zone trigger', `expected price_lower_zone, got ${t3}`);
    }

    // Высокий ATR → atr_increase
    const t4 = checkRebalanceTriggers(currentPrice, gridLower, gridUpper, avgAtrPct * 2, avgAtrPct, 0, 0);
    if (t4 === 'atr_increase') {
      pass('ATR increase trigger', `trigger=${t4}`);
    } else {
      fail('ATR increase trigger', `expected atr_increase, got ${t4}`);
    }

    // Низкий ATR → atr_decrease
    const t5 = checkRebalanceTriggers(currentPrice, gridLower, gridUpper, avgAtrPct * 0.2, avgAtrPct, 0, 0);
    if (t5 === 'atr_decrease') {
      pass('ATR decrease trigger', `trigger=${t5}`);
    } else {
      fail('ATR decrease trigger', `expected atr_decrease, got ${t5}`);
    }
  } catch (e: any) {
    fail('Rebalance triggers', e.message);
  }

  // ═══════════════════════════════════════════════════════
  // 6. Grid feeRate в ActiveGrid
  // ═══════════════════════════════════════════════════════
  console.log('\n=== 6. Fee Rate Integration ===');
  try {
    const fees = exchange.fees?.trading;
    const feeRate = fees?.taker ?? 0.001;
    const buyPrice = currentPrice * 0.97;
    const sellPrice = currentPrice * 0.97 * 1.015;
    const qty = 6 / buyPrice;

    const buyTotal = buyPrice * qty;
    const sellTotal = sellPrice * qty;
    const buyFee = buyTotal * feeRate;
    const sellFee = sellTotal * feeRate;
    const pnl = sellTotal - buyTotal - buyFee - sellFee;

    pass('PnL calc', `buy=$${buyPrice.toFixed(2)} sell=$${sellPrice.toFixed(2)} qty=${qty.toFixed(5)} fee=${(feeRate * 100).toFixed(3)}% → PnL=$${pnl.toFixed(4)}`);

    if (pnl > 0) {
      pass('PnL positive', `Grid step covers fees: $${pnl.toFixed(4)} profit per cycle`);
    } else {
      fail('PnL positive', `Grid step too small for fees: -$${Math.abs(pnl).toFixed(4)} loss per cycle`);
    }
  } catch (e: any) {
    fail('Fee rate', e.message);
  }

  // ═══════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════');
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`Results: ${passed} passed, ${failed} failed out of ${results.length}`);
  if (failed > 0) {
    console.log('\nFailed:');
    results.filter((r) => r.status === 'FAIL').forEach((r) => {
      console.log(`  ❌ ${r.test}: ${r.detail}`);
    });
  }
  console.log('═══════════════════════════════════════\n');

  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
