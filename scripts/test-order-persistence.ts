// @ts-nocheck
/**
 * Integration test: сохранение и восстановление ордеров в БД.
 *
 * Проверяет всю логику персистентности GridService без биржи:
 *  1. Создание GridState и GridOrders при setupGrid
 *  2. Восстановление ордеров при рестарте (onModuleInit)
 *  3. Обновление статуса ордера при исполнении (fill)
 *  4. Отмена грида — все ордера помечаются 'cancelled'
 *  5. Cleanup: удаление тестовых данных
 *
 * Запуск: npx tsx scripts/test-order-persistence.ts
 */

import 'dotenv/config';
import { randomUUID } from 'node:crypto';

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
  function assert(condition: boolean, test: string, ok: string, err: string) {
    condition ? pass(test, ok) : fail(test, err);
  }

  const { PrismaClient } = await import('../generated/prisma/client.js');
  const prisma = new PrismaClient();
  await prisma.$connect();

  const PAIR = 'SOL/USDT-TEST';
  let gridStateId: bigint | null = null;

  // ─── 1. Create GridState ─────────────────────────────────────────────────
  console.log('\n=== 1. Create GridState ===');
  try {
    const gridState = await prisma.gridState.create({
      data: {
        pair: PAIR,
        updatedAt: new Date(),
        lowerBound: 85.0,
        upperBound: 95.0,
        gridStepPct: 4.0,
        levelsCount: 2,
        capitalUsdt: 14,
        active: true,
      },
    });
    gridStateId = gridState.id;
    pass('Create GridState', `id=${gridStateId}, pair=${PAIR}, active=true`);
  } catch (e: any) {
    fail('Create GridState', e.message);
    await cleanup(prisma, PAIR);
    process.exit(1);
  }

  // ─── 2. Save GridOrders (simulate placeOrder for 2 buy orders) ───────────
  console.log('\n=== 2. Save GridOrders to DB ===');
  const testOrders = [
    {
      levelIndex: 0,
      side: 'buy',
      price: 87.0,
      quantity: 0.08,
      exchangeOrderId: `test-buy-${randomUUID().slice(0, 8)}`,
      gridCycleId: randomUUID(),
    },
    {
      levelIndex: 1,
      side: 'buy',
      price: 83.5,
      quantity: 0.08,
      exchangeOrderId: `test-buy-${randomUUID().slice(0, 8)}`,
      gridCycleId: randomUUID(),
    },
  ];

  try {
    for (const o of testOrders) {
      await prisma.gridOrder.create({
        data: {
          gridStateId,
          levelIndex: o.levelIndex,
          side: o.side,
          price: o.price,
          quantity: o.quantity,
          status: 'placed',
          exchangeOrderId: o.exchangeOrderId,
          gridCycleId: o.gridCycleId,
          placedAt: new Date(),
        },
      });
    }

    const saved = await prisma.gridOrder.findMany({
      where: { gridStateId },
    });

    assert(
      saved.length === testOrders.length,
      'Save GridOrders',
      `${saved.length} orders saved with status='placed'`,
      `Expected ${testOrders.length}, got ${saved.length}`,
    );
    assert(
      saved.every((o) => o.status === 'placed' && o.exchangeOrderId),
      'Order fields',
      'All orders have exchangeOrderId and status=placed',
      'Some orders missing exchangeOrderId or wrong status',
    );
  } catch (e: any) {
    fail('Save GridOrders', e.message);
  }

  // ─── 3. Simulate restart: restore orders from DB (onModuleInit) ──────────
  console.log('\n=== 3. Restore orders on restart (onModuleInit) ===');
  try {
    // This replicates exactly what GridService.onModuleInit does
    const activeGrid = await prisma.gridState.findFirst({
      where: { active: true },
      orderBy: { updatedAt: 'desc' },
      include: { orders: true },
    });

    assert(
      activeGrid !== null,
      'Find active grid',
      `Found active grid id=${activeGrid?.id}`,
      'No active grid found in DB',
    );

    const restoredOrders = activeGrid.orders
      .filter((o) => o.status === 'placed' || o.status === 'pending')
      .map((o) => ({
        levelIndex: o.levelIndex,
        side: o.side,
        price: Number(o.price),
        quantity: Number(o.quantity),
        status: o.status,
        exchangeOrderId: o.exchangeOrderId ?? undefined,
        gridCycleId: o.gridCycleId ?? randomUUID(),
        placedAt: o.placedAt ?? undefined,
      }));

    assert(
      restoredOrders.length === testOrders.length,
      'Restore orders',
      `${restoredOrders.length} orders restored from DB`,
      `Expected ${testOrders.length}, restored ${restoredOrders.length}`,
    );

    const firstRestored = restoredOrders[0];
    assert(
      Math.abs(firstRestored.price - testOrders[0].price) < 0.01,
      'Restore price accuracy',
      `price=${firstRestored.price} matches original ${testOrders[0].price}`,
      `Restored price ${firstRestored.price} != original ${testOrders[0].price}`,
    );

    assert(
      restoredOrders.every((o) => o.exchangeOrderId),
      'Restore exchangeOrderId',
      'All restored orders have exchangeOrderId',
      'Some restored orders missing exchangeOrderId',
    );
  } catch (e: any) {
    fail('Restore on restart', e.message);
  }

  // ─── 4. Simulate fill: mark order as filled, save counter-order ──────────
  console.log('\n=== 4. Fill order → update status + create sell counter-order ===');
  const filledOrderId = testOrders[0].exchangeOrderId;
  try {
    // Mark buy as filled (updateOrderStatusInDb)
    await prisma.gridOrder.updateMany({
      where: { exchangeOrderId: filledOrderId },
      data: { status: 'filled' },
    });

    const filledRow = await prisma.gridOrder.findFirst({
      where: { exchangeOrderId: filledOrderId },
    });
    assert(
      filledRow?.status === 'filled',
      'Mark order filled',
      `Order ${filledOrderId} status updated to 'filled'`,
      `Expected 'filled', got '${filledRow?.status}'`,
    );

    // Save counter sell order (simulate onBuyFilled → placeOrder → saveOrderToDb)
    const sellPrice = testOrders[0].price * 1.04; // gridStepPct = 4%
    const counterExId = `test-sell-${randomUUID().slice(0, 8)}`;
    await prisma.gridOrder.create({
      data: {
        gridStateId,
        levelIndex: testOrders[0].levelIndex,
        side: 'sell',
        price: sellPrice,
        quantity: testOrders[0].quantity,
        status: 'placed',
        exchangeOrderId: counterExId,
        gridCycleId: testOrders[0].gridCycleId,
        placedAt: new Date(),
      },
    });
    testOrders.push({ ...testOrders[0], exchangeOrderId: counterExId, side: 'sell', price: sellPrice });

    const sellRow = await prisma.gridOrder.findFirst({
      where: { exchangeOrderId: counterExId },
    });
    assert(
      sellRow !== null && sellRow.side === 'sell' && sellRow.status === 'placed',
      'Save counter sell order',
      `Sell counter order saved @ $${Number(sellRow?.price).toFixed(2)}`,
      'Counter sell order not found in DB',
    );

    // Trade record (simulate prisma.trade.create)
    await prisma.trade.create({
      data: {
        pair: PAIR,
        executedAt: new Date(),
        side: 'buy',
        price: testOrders[0].price,
        quantity: testOrders[0].quantity,
        feeUsdt: testOrders[0].price * testOrders[0].quantity * 0.001,
        gridCycleId: testOrders[0].gridCycleId,
        exchangeOrderId: filledOrderId,
      },
    });

    const trade = await prisma.trade.findFirst({
      where: { exchangeOrderId: filledOrderId },
    });
    assert(
      trade !== null,
      'Trade saved to DB',
      `Trade record created: ${trade?.side} @ $${Number(trade?.price).toFixed(2)}`,
      'Trade record not found in DB',
    );
  } catch (e: any) {
    fail('Fill processing', e.message);
  }

  // ─── 5. Cancel grid: mark all orders as cancelled ────────────────────────
  console.log('\n=== 5. Cancel grid → mark orders cancelled ===');
  try {
    // GridService.cancelGrid → prisma.gridState.update + prisma.gridOrder.updateMany
    await prisma.gridState.update({
      where: { id: gridStateId },
      data: { active: false, updatedAt: new Date() },
    });

    await prisma.gridOrder.updateMany({
      where: {
        gridStateId,
        status: { in: ['placed', 'pending'] },
      },
      data: { status: 'cancelled' },
    });

    const updatedGrid = await prisma.gridState.findUnique({
      where: { id: gridStateId },
    });
    assert(
      updatedGrid?.active === false,
      'Grid marked inactive',
      `GridState id=${gridStateId} active=false`,
      `GridState still active`,
    );

    const remaining = await prisma.gridOrder.findMany({
      where: { gridStateId, status: { in: ['placed', 'pending'] } },
    });
    assert(
      remaining.length === 0,
      'All orders cancelled',
      'No placed/pending orders remain in DB',
      `${remaining.length} orders still placed/pending`,
    );

    // Filled order should NOT be overwritten to 'cancelled'
    const filledRow = await prisma.gridOrder.findFirst({
      where: { exchangeOrderId: testOrders[0].exchangeOrderId },
    });
    assert(
      filledRow?.status === 'filled',
      'Filled order preserved',
      `Filled order status unchanged: '${filledRow?.status}'`,
      `Filled order was incorrectly changed to '${filledRow?.status}'`,
    );
  } catch (e: any) {
    fail('Cancel grid', e.message);
  }

  // ─── 6. Cleanup ──────────────────────────────────────────────────────────
  console.log('\n=== 6. Cleanup test data ===');
  const deleted = await cleanup(prisma, PAIR);
  pass('Cleanup', `Removed ${deleted.orders} orders, ${deleted.trades} trades, ${deleted.grids} grid states`);

  // ─── Summary ─────────────────────────────────────────────────────────────
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

async function cleanup(prisma: any, pair: string) {
  const grids = await prisma.gridState.findMany({ where: { pair }, select: { id: true } });
  const gridIds = grids.map((g: any) => g.id);

  const orders = gridIds.length
    ? await prisma.gridOrder.deleteMany({ where: { gridStateId: { in: gridIds } } })
    : { count: 0 };

  const trades = await prisma.trade.deleteMany({ where: { pair } });

  const deleted = await prisma.gridState.deleteMany({ where: { pair } });

  return { orders: orders.count, trades: trades.count, grids: deleted.count };
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
