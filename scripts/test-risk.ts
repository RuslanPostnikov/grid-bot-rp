// @ts-nocheck
/**
 * Integration test: Risk Management модуль.
 *
 * 1. Position sizing (60/30/10 split)
 * 2. Drawdown calculation
 * 3. Price deviation detection
 * 4. Risk level escalation: normal → warning → pause → stop
 * 5. Balance buffer protection
 *
 * Запуск: npx tsx scripts/test-risk.ts
 */

import {
  calculatePositionSizing,
  calculateDrawdownPct,
  calculatePriceDeviation,
  evaluateRisk,
} from '../src/modules/risk/risk-calculator.js';
import { DEFAULT_RISK_CONFIG } from '../src/modules/risk/risk.types.js';

function main() {
  const results: { test: string; status: 'PASS' | 'FAIL'; detail: string }[] = [];

  function pass(test: string, detail: string) {
    results.push({ test, status: 'PASS', detail });
    console.log(`  ✅ ${test}: ${detail}`);
  }
  function fail(test: string, detail: string) {
    results.push({ test, status: 'FAIL', detail });
    console.log(`  ❌ ${test}: ${detail}`);
  }

  const config = DEFAULT_RISK_CONFIG;

  // --- 1. Position Sizing ---
  console.log('\n=== 1. Position Sizing ===');
  const sizing = calculatePositionSizing(10_000, config);
  if (sizing.activeCapital === 6_000 && sizing.reserveCapital === 3_000 && sizing.bufferCapital === 1_000) {
    pass('Position sizing', `Active=$${sizing.activeCapital}, Reserve=$${sizing.reserveCapital}, Buffer=$${sizing.bufferCapital}`);
  } else {
    fail('Position sizing', `Got: active=${sizing.activeCapital}, reserve=${sizing.reserveCapital}, buffer=${sizing.bufferCapital}`);
  }

  // --- 2. Drawdown Calculation ---
  console.log('\n=== 2. Drawdown Calculation ===');
  const dd1 = calculateDrawdownPct(10_000, 9_500);
  if (Math.abs(dd1 - 5) < 0.01) {
    pass('Drawdown 5%', `Peak=$10000 → Current=$9500 → DD=${dd1.toFixed(2)}%`);
  } else {
    fail('Drawdown 5%', `Expected 5%, got ${dd1.toFixed(2)}%`);
  }

  const dd2 = calculateDrawdownPct(10_000, 10_500);
  if (dd2 === 0) {
    pass('No drawdown when up', `Peak=$10000, Current=$10500 → DD=0%`);
  } else {
    fail('No drawdown when up', `Expected 0%, got ${dd2.toFixed(2)}%`);
  }

  // --- 3. Price Deviation ---
  console.log('\n=== 3. Price Deviation ===');
  const dev1 = calculatePriceDeviation(100, 90, 110);
  if (dev1 === 0) {
    pass('Price inside grid', `Price=$100 in [$90-$110] → deviation=0%`);
  } else {
    fail('Price inside grid', `Expected 0%, got ${dev1.toFixed(2)}%`);
  }

  const dev2 = calculatePriceDeviation(85, 90, 110);
  if (dev2 > 5) {
    pass('Price below grid', `Price=$85, lower=$90 → deviation=${dev2.toFixed(2)}%`);
  } else {
    fail('Price below grid', `Expected >5%, got ${dev2.toFixed(2)}%`);
  }

  const dev3 = calculatePriceDeviation(115, 90, 110);
  if (dev3 > 4) {
    pass('Price above grid', `Price=$115, upper=$110 → deviation=${dev3.toFixed(2)}%`);
  } else {
    fail('Price above grid', `Expected >4%, got ${dev3.toFixed(2)}%`);
  }

  // --- 4. Risk Level Escalation ---
  console.log('\n=== 4. Risk Level Escalation ===');

  // Normal
  const r1 = evaluateRisk(0, 0, 0, 10_000, 10_000, config);
  if (r1.level === 'normal') {
    pass('Level: normal', 'No drawdown, no deviation → normal');
  } else {
    fail('Level: normal', `Expected normal, got ${r1.level}`);
  }

  // Warning (daily DD 3-5%)
  const r2 = evaluateRisk(3.5, 0, 0, 9_650, 10_000, config);
  if (r2.level === 'warning') {
    pass('Level: warning', `Daily DD=3.5% → warning (threshold=${config.warningDrawdownPct}%)`);
  } else {
    fail('Level: warning', `Expected warning, got ${r2.level}`);
  }

  // Pause (daily DD >= 5%)
  const r3 = evaluateRisk(5.5, 0, 0, 9_450, 10_000, config);
  if (r3.level === 'pause') {
    pass('Level: pause (daily DD)', `Daily DD=5.5% → pause (threshold=${config.maxDailyDrawdownPct}%)`);
  } else {
    fail('Level: pause (daily DD)', `Expected pause, got ${r3.level}`);
  }

  // Pause (price deviation >= 3%)
  const r4 = evaluateRisk(0, 0, 4.0, 10_000, 10_000, config);
  if (r4.level === 'pause') {
    pass('Level: pause (price dev)', `Price deviation=4% → pause (threshold=${config.maxPriceDeviationPct}%)`);
  } else {
    fail('Level: pause (price dev)', `Expected pause, got ${r4.level}`);
  }

  // Stop (weekly DD >= 15%)
  const r5 = evaluateRisk(0, 16, 0, 8_400, 10_000, config);
  if (r5.level === 'stop') {
    pass('Level: stop (weekly DD)', `Weekly DD=16% → stop (threshold=${config.maxWeeklyDrawdownPct}%)`);
  } else {
    fail('Level: stop (weekly DD)', `Expected stop, got ${r5.level}`);
  }

  // --- 5. Buffer Balance Protection ---
  console.log('\n=== 5. Buffer Balance Protection ===');
  const r6 = evaluateRisk(0, 0, 0, 900, 10_000, config);
  if (r6.level === 'stop') {
    pass('Buffer protection', `Balance=$900 <= min buffer $${r6.minAllowedBalance} → STOP`);
  } else {
    fail('Buffer protection', `Expected stop, got ${r6.level}`);
  }

  // Stop overrides pause
  const r7 = evaluateRisk(6, 16, 5, 800, 10_000, config);
  if (r7.level === 'stop' && r7.reasons.length >= 2) {
    pass('Stop overrides', `Multiple triggers: ${r7.reasons.length} reasons, level=stop`);
  } else {
    fail('Stop overrides', `Expected stop with multiple reasons, got ${r7.level} with ${r7.reasons.length}`);
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

  process.exit(failed > 0 ? 1 : 0);
}

main();
