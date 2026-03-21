/**
 * CLI для запуска бэктеста.
 *
 * Использование:
 *   npx ts-node backtesting/run.ts <data-file> [--optimize]
 *
 * Примеры:
 *   npx ts-node backtesting/run.ts backtesting/data/BTC-USDT_1h.json
 *   npx ts-node backtesting/run.ts backtesting/data/BTC-USDT_1h.json --optimize
 */

import * as fs from 'fs';
import { runBacktest, runOptimization } from './engine.js';
import { DEFAULT_CONFIG } from './types.js';
import type { BacktestResult, OHLCV } from './types.js';

function loadCandles(filepath: string): OHLCV[] {
  const raw = fs.readFileSync(filepath, 'utf-8');
  return JSON.parse(raw) as OHLCV[];
}

function printResult(result: BacktestResult): void {
  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log('           BACKTEST RESULTS');
  console.log('═══════════════════════════════════════════');
  console.log('');
  console.log(`Period:        ${result.periodStart.slice(0, 10)} → ${result.periodEnd.slice(0, 10)}`);
  console.log(`Candles:       ${result.totalCandles}`);
  console.log(`Price:         $${result.startPrice.toFixed(2)} → $${result.endPrice.toFixed(2)}`);
  console.log('');
  console.log('--- PnL ---');
  console.log(`Grid PnL:      $${result.totalPnl.toFixed(2)} (${result.totalPnlPct.toFixed(2)}%)`);
  console.log(`Total fees:    $${result.totalFees.toFixed(2)}`);
  console.log(`Net PnL:       $${result.netPnl.toFixed(2)} (${result.netPnlPct.toFixed(2)}%)`);
  console.log('');
  console.log('--- HODL Comparison ---');
  console.log(`HODL PnL:      $${result.hodlPnl.toFixed(2)} (${result.hodlPnlPct.toFixed(2)}%)`);
  console.log(`Grid vs HODL:  $${result.vsHodl.toFixed(2)}`);
  console.log('');
  console.log('--- Trades ---');
  console.log(`Total cycles:  ${result.totalCycles}`);
  console.log(`Profitable:    ${result.profitableCycles}`);
  console.log(`Win rate:      ${result.winRate.toFixed(1)}%`);
  console.log(`Avg profit:    $${result.avgProfitPerCycle.toFixed(2)}`);
  console.log('');
  console.log('--- Risk ---');
  console.log(`Max drawdown:  $${result.maxDrawdown.toFixed(2)} (${result.maxDrawdownPct.toFixed(2)}%)`);
  console.log(`Sharpe ratio:  ${result.sharpeRatio.toFixed(2)}`);
  console.log('');
  console.log('--- Grid ---');
  console.log(`Step:          ${result.config.gridStepPct}%`);
  console.log(`Rebalances:    ${result.totalRebalances}`);
  console.log(`Out of range:  ${result.timesOutOfRange} candles`);
  console.log('');
  console.log('═══════════════════════════════════════════');
}

function printOptimization(
  results: { stepPct: number; result: BacktestResult }[],
): void {
  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log('        PARAMETER OPTIMIZATION');
  console.log('═══════════════════════════════════════════');
  console.log('');
  console.log(
    'Step%  | Net PnL     | PnL%    | Win%  | Cycles | MaxDD%  | Sharpe',
  );
  console.log(
    '-------|-------------|---------|-------|--------|---------|-------',
  );

  for (const { stepPct, result } of results) {
    console.log(
      `${stepPct.toFixed(2).padStart(5)}% | ` +
        `$${result.netPnl.toFixed(2).padStart(10)} | ` +
        `${result.netPnlPct.toFixed(2).padStart(6)}% | ` +
        `${result.winRate.toFixed(1).padStart(4)}% | ` +
        `${String(result.totalCycles).padStart(6)} | ` +
        `${result.maxDrawdownPct.toFixed(2).padStart(6)}% | ` +
        `${result.sharpeRatio.toFixed(2).padStart(5)}`,
    );
  }

  const best = results.reduce((a, b) =>
    a.result.netPnl > b.result.netPnl ? a : b,
  );
  console.log('');
  console.log(`Best step: ${best.stepPct}% → $${best.result.netPnl.toFixed(2)} net PnL`);
  console.log('');
}

// --- Main ---

const args = process.argv.slice(2);
const filepath = args[0];
const optimize = args.includes('--optimize');

if (!filepath) {
  console.error('Usage: npx ts-node backtesting/run.ts <data-file> [--optimize]');
  process.exit(1);
}

if (!fs.existsSync(filepath)) {
  console.error(`File not found: ${filepath}`);
  process.exit(1);
}

const candles = loadCandles(filepath);
console.log(`Loaded ${candles.length} candles from ${filepath}`);

if (optimize) {
  const results = runOptimization(candles, DEFAULT_CONFIG);
  printOptimization(results);
} else {
  const result = runBacktest(candles, DEFAULT_CONFIG);
  printResult(result);
}
