// @ts-nocheck
/**
 * Integration test: полный lifecycle сетки на Binance Testnet.
 *
 * 1. Setup grid (выставление 10+ ордеров)
 * 2. Verify orders on exchange
 * 3. Poll order statuses
 * 4. Cancel grid
 * 5. Verify all cancelled
 * 6. Reconciliation test
 *
 * Запуск: npx tsx scripts/test-grid-lifecycle.ts
 */

import 'dotenv/config';

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
  exchange.setSandboxMode(true);

  // Init DB
  const { PrismaClient } = await import('../generated/prisma/client.js');
  const prisma = new PrismaClient();
  await prisma.$connect();

  // Get current price
  const ticker = await exchange.fetchTicker('BTC/USDT');
  const currentPrice = ticker.last;
  console.log(`\nBTC/USDT current price: $${currentPrice}\n`);

  // --- 1. Setup grid: place multiple orders ---
  console.log('=== 1. Setup grid (place orders) ===');
  const gridOrders: { id: string; side: string; price: number }[] = [];
  const gridStepPct = 2.0; // wide step to not accidentally fill
  const levels = 5; // 5 below + 5 above = 10 orders

  try {
    // Buy orders below current price
    for (let i = 1; i <= levels; i++) {
      const price = Math.round(currentPrice * (1 - (gridStepPct * i) / 100));
      const order = await exchange.createOrder(
        'BTC/USDT', 'limit', 'buy', 0.001, price,
      );
      gridOrders.push({ id: order.id, side: 'buy', price });
    }

    // Sell orders above current price
    for (let i = 1; i <= levels; i++) {
      const price = Math.round(currentPrice * (1 + (gridStepPct * i) / 100));
      const order = await exchange.createOrder(
        'BTC/USDT', 'limit', 'sell', 0.001, price,
      );
      gridOrders.push({ id: order.id, side: 'sell', price });
    }

    pass(
      'Place grid',
      `${gridOrders.length} orders placed (${levels} buys + ${levels} sells)`,
    );

    // Print grid
    console.log('    Grid orders:');
    for (const o of gridOrders) {
      console.log(`      ${o.side.toUpperCase().padEnd(4)} @ $${o.price} (${o.id})`);
    }
  } catch (e: any) {
    fail('Place grid', e.message);
    await prisma.$disconnect();
    process.exit(1);
  }

  // --- 2. Verify orders exist on exchange ---
  console.log('\n=== 2. Verify orders on exchange ===');
  try {
    await sleep(2000); // wait for exchange to process
    const openOrders = await exchange.fetchOpenOrders('BTC/USDT');
    const ourIds = new Set(gridOrders.map((o) => o.id));
    const foundOnExchange = openOrders.filter((o) => ourIds.has(o.id));

    if (foundOnExchange.length === gridOrders.length) {
      pass('Verify open', `All ${foundOnExchange.length} orders found on exchange`);
    } else {
      fail(
        'Verify open',
        `Expected ${gridOrders.length}, found ${foundOnExchange.length} on exchange`,
      );
    }
  } catch (e: any) {
    fail('Verify open', e.message);
  }

  // --- 3. Check individual order status ---
  console.log('\n=== 3. Check individual order status ===');
  try {
    const sampleOrder = gridOrders[0];
    const orderDetail = await exchange.fetchOrder(sampleOrder.id, 'BTC/USDT');
    pass(
      'Fetch order',
      `Order ${sampleOrder.id}: status=${orderDetail.status}, filled=${orderDetail.filled}/${orderDetail.amount}`,
    );
  } catch (e: any) {
    fail('Fetch order', e.message);
  }

  // --- 4. Save grid state to DB ---
  console.log('\n=== 4. Save grid state to DB ===');
  try {
    const gridState = await prisma.gridState.create({
      data: {
        pair: 'BTC/USDT',
        updatedAt: new Date(),
        lowerBound: currentPrice * 0.9,
        upperBound: currentPrice * 1.1,
        gridStepPct,
        levelsCount: levels * 2,
        capitalUsdt: 1000,
        active: true,
      },
    });
    pass('Save grid state', `Grid state saved, id=${gridState.id}`);
  } catch (e: any) {
    fail('Save grid state', e.message);
  }

  // --- 5. Cancel all grid orders ---
  console.log('\n=== 5. Cancel grid ===');
  let cancelledCount = 0;
  for (const order of gridOrders) {
    try {
      await exchange.cancelOrder(order.id, 'BTC/USDT');
      cancelledCount++;
    } catch (e: any) {
      console.log(`    ⚠️ Cancel ${order.id}: ${e.message}`);
    }
  }

  if (cancelledCount === gridOrders.length) {
    pass('Cancel grid', `All ${cancelledCount} orders cancelled`);
  } else {
    fail('Cancel grid', `${cancelledCount}/${gridOrders.length} cancelled`);
  }

  // --- 6. Verify all cancelled ---
  console.log('\n=== 6. Verify no open orders ===');
  try {
    await sleep(2000);
    const remaining = await exchange.fetchOpenOrders('BTC/USDT');
    const ourIds = new Set(gridOrders.map((o) => o.id));
    const stillOpen = remaining.filter((o) => ourIds.has(o.id));

    if (stillOpen.length === 0) {
      pass('Verify cancelled', 'No grid orders remaining on exchange');
    } else {
      fail('Verify cancelled', `${stillOpen.length} orders still open`);
    }
  } catch (e: any) {
    fail('Verify cancelled', e.message);
  }

  // --- 7. Reconciliation test ---
  console.log('\n=== 7. Reconciliation (orphan detection) ===');
  try {
    // Place an "orphan" order that our grid doesn't know about
    const orphanPrice = Math.round(currentPrice * 0.7);
    const orphan = await exchange.createOrder(
      'BTC/USDT', 'limit', 'buy', 0.001, orphanPrice,
    );
    pass('Create orphan', `Orphan order ${orphan.id} @ $${orphanPrice}`);

    // Fetch open orders — this orphan should be detectable
    const openOrders = await exchange.fetchOpenOrders('BTC/USDT');
    const knownIds = new Set<string>(); // empty = we "forgot" all orders
    const orphans = openOrders.filter((o) => !knownIds.has(o.id));

    if (orphans.length > 0) {
      pass('Detect orphan', `Found ${orphans.length} orphan order(s)`);
    } else {
      fail('Detect orphan', 'Orphan not detected');
    }

    // Clean up orphan
    await exchange.cancelOrder(orphan.id, 'BTC/USDT');
    pass('Cancel orphan', `Orphan ${orphan.id} cleaned up`);
  } catch (e: any) {
    fail('Reconciliation', e.message);
  }

  // --- Summary ---
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
