/**
 * Integration test: проверяет подключение к Binance Testnet,
 * сбор данных, запись в БД, и выставление/отмену ордера.
 *
 * Запуск: npx ts-node scripts/integration-test.ts
 */

// @ts-nocheck
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

  // --- 1. Database connection ---
  console.log('\n=== 1. Database ===');
  let prisma: any;
  try {
    const { PrismaClient } = await import('../generated/prisma/client.js');
    prisma = new PrismaClient();
    await prisma.$connect();
    const count = await prisma.candle.count();
    pass('DB connect', `Connected, ${count} candles in DB`);
  } catch (e: any) {
    fail('DB connect', e.message);
    process.exit(1);
  }

  // --- 2. Exchange connection ---
  console.log('\n=== 2. Exchange (Binance Testnet) ===');
  let exchange: any;
  try {
    const ccxt = await import('ccxt');
    exchange = new (ccxt as any).binance({
      apiKey: process.env.EXCHANGE_API_KEY,
      secret: process.env.EXCHANGE_API_SECRET,
      enableRateLimit: true,
    });
    exchange.setSandboxMode(true);
    pass('Exchange init', 'Binance testnet sandbox mode');
  } catch (e: any) {
    fail('Exchange init', e.message);
    process.exit(1);
  }

  // --- 3. Fetch ticker ---
  console.log('\n=== 3. Fetch ticker ===');
  let currentPrice = 0;
  try {
    const ticker = await exchange.fetchTicker('BTC/USDT');
    currentPrice = ticker.last;
    pass('Fetch ticker', `BTC/USDT = $${currentPrice}`);
  } catch (e: any) {
    fail('Fetch ticker', e.message);
  }

  // --- 4. Fetch OHLCV ---
  console.log('\n=== 4. Fetch OHLCV ===');
  try {
    const candles = await exchange.fetchOHLCV('BTC/USDT', '1h', undefined, 5);
    pass('Fetch OHLCV', `Got ${candles.length} candles`);

    // Write to DB
    let stored = 0;
    for (const c of candles) {
      const openTime = new Date(c[0]);
      const existing = await prisma.candle.findUnique({
        where: {
          pair_timeframe_openTime: {
            pair: 'BTC/USDT',
            timeframe: '1h',
            openTime,
          },
        },
      });
      if (!existing) {
        await prisma.candle.create({
          data: {
            pair: 'BTC/USDT',
            timeframe: '1h',
            openTime,
            open: c[1],
            high: c[2],
            low: c[3],
            close: c[4],
            volume: c[5],
          },
        });
        stored++;
      }
    }
    pass('Store candles', `${stored} new candles stored in DB`);
  } catch (e: any) {
    fail('Fetch/Store OHLCV', e.message);
  }

  // --- 5. Fetch balance ---
  console.log('\n=== 5. Fetch balance ===');
  try {
    const balance = await exchange.fetchBalance();
    const usdt = balance.free?.USDT ?? balance.free?.usdt ?? 0;
    const btc = balance.free?.BTC ?? balance.free?.btc ?? 0;
    pass('Fetch balance', `USDT: ${usdt}, BTC: ${btc}`);
  } catch (e: any) {
    fail('Fetch balance', e.message);
  }

  // --- 6. Place & cancel test order ---
  console.log('\n=== 6. Place & cancel order ===');
  if (currentPrice > 0) {
    try {
      // Place a buy limit far below current price (won't fill)
      const testPrice = Math.round(currentPrice * 0.5);
      const order = await exchange.createOrder(
        'BTC/USDT',
        'limit',
        'buy',
        0.001,
        testPrice,
      );
      pass('Place order', `Order ${order.id}: buy 0.001 BTC @ $${testPrice}`);

      // Cancel it
      await exchange.cancelOrder(order.id, 'BTC/USDT');
      pass('Cancel order', `Order ${order.id} cancelled`);
    } catch (e: any) {
      fail('Place/cancel order', e.message);
    }
  } else {
    fail('Place order', 'No current price, skipping');
  }

  // --- 7. Fetch order book ---
  console.log('\n=== 7. Order book ===');
  try {
    const book = await exchange.fetchOrderBook('BTC/USDT', 5);
    pass(
      'Order book',
      `${book.bids.length} bids, ${book.asks.length} asks, spread: $${(book.asks[0][0] - book.bids[0][0]).toFixed(2)}`,
    );
  } catch (e: any) {
    fail('Order book', e.message);
  }

  // --- Summary ---
  console.log('\n═══════════════════════════════════════');
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`Results: ${passed} passed, ${failed} failed out of ${results.length} tests`);
  if (failed > 0) {
    console.log('\nFailed tests:');
    results.filter((r) => r.status === 'FAIL').forEach((r) => {
      console.log(`  ❌ ${r.test}: ${r.detail}`);
    });
  }
  console.log('═══════════════════════════════════════\n');

  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
