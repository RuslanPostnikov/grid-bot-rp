/**
 * Скрипт загрузки исторических OHLCV данных через публичный API.
 * Не требует API ключей.
 *
 * Использование:
 *   npx ts-node backtesting/fetch-history.ts [pair] [timeframe] [months]
 *
 * Примеры:
 *   npx ts-node backtesting/fetch-history.ts BTC/USDT 1h 12
 *   npx ts-node backtesting/fetch-history.ts ETH/USDT 4h 6
 */

import * as fs from 'fs';
import * as path from 'path';

interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const BATCH_SIZE = 1000;
const RATE_LIMIT_MS = 1200;

async function loadCcxt() {
  // Dynamic import to avoid type issues
  const ccxt = await import('ccxt');
  return ccxt;
}

async function fetchHistory(
  pair: string,
  timeframe: string,
  months: number,
): Promise<OHLCV[]> {
  const ccxt = await loadCcxt();
  const exchange = new (ccxt as any).binance({ enableRateLimit: true });

  const now = Date.now();
  const msPerMonth = 30 * 24 * 60 * 60 * 1000;
  let since = now - months * msPerMonth;

  const allCandles: OHLCV[] = [];
  let batch = 0;

  console.log(`Fetching ${pair} ${timeframe} for last ${months} months...`);
  console.log(`From: ${new Date(since).toISOString()}`);
  console.log(`To:   ${new Date(now).toISOString()}`);
  console.log('');

  while (since < now) {
    try {
      const raw: number[][] = await exchange.fetchOHLCV(
        pair,
        timeframe,
        since,
        BATCH_SIZE,
      );

      if (raw.length === 0) break;

      for (const r of raw) {
        allCandles.push({
          timestamp: r[0],
          open: r[1],
          high: r[2],
          low: r[3],
          close: r[4],
          volume: r[5],
        });
      }

      since = raw[raw.length - 1][0] + 1;
      batch++;

      if (batch % 10 === 0) {
        console.log(
          `  Batch ${batch}: ${allCandles.length} candles, up to ${new Date(since).toISOString()}`,
        );
      }

      await sleep(RATE_LIMIT_MS);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`Error fetching batch ${batch}: ${msg}`);
      console.log('Retrying in 5s...');
      await sleep(5000);
    }
  }

  // Deduplicate by timestamp
  const seen = new Set<number>();
  const unique = allCandles.filter((c) => {
    if (seen.has(c.timestamp)) return false;
    seen.add(c.timestamp);
    return true;
  });

  return unique.sort((a, b) => a.timestamp - b.timestamp);
}

function saveToFile(candles: OHLCV[], pair: string, timeframe: string): string {
  const safePair = pair.replace('/', '-');
  const filename = `${safePair}_${timeframe}.json`;
  const filepath = path.join(__dirname, 'data', filename);

  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  fs.writeFileSync(filepath, JSON.stringify(candles, null, 2));

  return filepath;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Main ---

async function main() {
  const pair = process.argv[2] || 'BTC/USDT';
  const timeframe = process.argv[3] || '1h';
  const months = parseInt(process.argv[4] || '12', 10);

  const candles = await fetchHistory(pair, timeframe, months);
  const filepath = saveToFile(candles, pair, timeframe);

  const first = candles[0];
  const last = candles[candles.length - 1];

  console.log('');
  console.log('=== Done ===');
  console.log(`Total candles: ${candles.length}`);
  console.log(`Period: ${new Date(first.timestamp).toISOString()} → ${new Date(last.timestamp).toISOString()}`);
  console.log(`Price range: $${Math.min(...candles.map((c) => c.low)).toFixed(2)} — $${Math.max(...candles.map((c) => c.high)).toFixed(2)}`);
  console.log(`Saved to: ${filepath}`);
}

main().catch(console.error);
