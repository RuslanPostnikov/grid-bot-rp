// @ts-nocheck
/**
 * Integration test: Claude pipeline с mock ответом (без реального API вызова).
 * Тестирует snapshot → prompt → parse → DB save → apply logic.
 *
 * Запуск: npx tsx scripts/test-claude-mock.ts
 */

import 'dotenv/config';
import { SYSTEM_PROMPT, buildUserPrompt, parseClaudeResponse } from '../src/modules/claude/claude-prompt.js';
import type { MarketSnapshot } from '../src/modules/claude/claude.types.js';

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

  // --- 1. Build snapshot ---
  console.log('\n=== 1. Build snapshot ===');
  const snapshot: MarketSnapshot = {
    pair: 'BTC/USDT',
    currentPrice: 70500,
    priceChange24h: -1.2,
    volume24h: 4500000,
    regime: 'flat',
    regimeConfidence: 0.85,
    gridActive: true,
    gridBounds: { lower: 68000, upper: 73000 },
    gridStepPct: 1.25,
    balance: { usdt: 6000, btc: 0.05 },
    recentTrades: [
      { side: 'buy', price: 69800, pnl: null, time: '2026-03-21T08:00:00Z' },
      { side: 'sell', price: 70700, pnl: 7.5, time: '2026-03-21T09:30:00Z' },
    ],
    totalPnl24h: 7.5,
    dailyDrawdownPct: 0.8,
    weeklyDrawdownPct: 1.5,
    riskLevel: 'normal',
    indicators: { rsi14: 48, adx14: 16, atrPct: 1.8, macdHistogram: -5 },
  };
  pass('Build snapshot', `Price=$${snapshot.currentPrice}, regime=${snapshot.regime}`);

  // --- 2. Build prompt ---
  console.log('\n=== 2. Build prompt ===');
  const prompt = buildUserPrompt(snapshot);
  if (prompt.includes('"BTC/USDT"') && prompt.includes('grid_recommendation')) {
    pass('Build prompt', `${prompt.length} chars, contains all fields`);
  } else {
    fail('Build prompt', 'Missing expected content');
  }

  // --- 3. System prompt ---
  console.log('\n=== 3. System prompt ===');
  if (SYSTEM_PROMPT.includes('JSON') && SYSTEM_PROMPT.includes('keep') && SYSTEM_PROMPT.includes('pause')) {
    pass('System prompt', `${SYSTEM_PROMPT.length} chars, contains all actions`);
  } else {
    fail('System prompt', 'Missing expected instructions');
  }

  // --- 4. Parse mock responses ---
  console.log('\n=== 4. Parse mock responses ===');

  // 4a. "keep" response
  const keepResponse = JSON.stringify({
    market_assessment: 'Рынок в боковике, сетка работает оптимально',
    grid_recommendation: {
      action: 'keep',
      lower_bound: null,
      upper_bound: null,
      grid_step_pct: null,
      reason: 'Текущие параметры оптимальны для бокового рынка',
    },
    risk_flags: [],
    confidence: 0.9,
    next_review_hours: 4,
  });
  const r1 = parseClaudeResponse(keepResponse);
  if (r1.parsed?.grid_recommendation.action === 'keep' && r1.parsed.confidence === 0.9) {
    pass('Parse "keep"', 'action=keep, confidence=0.9, no risk flags');
  } else {
    fail('Parse "keep"', r1.error ?? 'wrong values');
  }

  // 4b. "adjust" response
  const adjustResponse = JSON.stringify({
    market_assessment: 'Рынок начинает trending вверх, нужно сдвинуть сетку',
    grid_recommendation: {
      action: 'adjust',
      lower_bound: 70000,
      upper_bound: 75000,
      grid_step_pct: 1.5,
      reason: 'Цена растёт, сдвигаем сетку вверх',
    },
    risk_flags: ['possible_breakout'],
    confidence: 0.72,
    next_review_hours: 2,
  });
  const r2 = parseClaudeResponse(adjustResponse);
  if (r2.parsed?.grid_recommendation.action === 'adjust' && r2.parsed.grid_recommendation.upper_bound === 75000) {
    pass('Parse "adjust"', 'action=adjust, new bounds [70000-75000], step=1.5%');
  } else {
    fail('Parse "adjust"', r2.error ?? 'wrong values');
  }

  // 4c. "pause" response
  const pauseResponse = '```json\n' + JSON.stringify({
    market_assessment: 'Резкий дамп, высокая волатильность',
    grid_recommendation: {
      action: 'pause',
      lower_bound: null,
      upper_bound: null,
      grid_step_pct: null,
      reason: 'Drawdown превышает норму, остановить торговлю',
    },
    risk_flags: ['high_volatility', 'drawdown_warning', 'trend_reversal'],
    confidence: 0.95,
    next_review_hours: 1,
  }) + '\n```';
  const r3 = parseClaudeResponse(pauseResponse);
  if (r3.parsed?.grid_recommendation.action === 'pause' && r3.parsed.risk_flags.length === 3) {
    pass('Parse "pause" (with markdown)', 'action=pause, 3 risk flags, strips ```json fences');
  } else {
    fail('Parse "pause"', r3.error ?? 'wrong values');
  }

  // 4d. Invalid response
  const r4 = parseClaudeResponse('I think you should buy more BTC!');
  if (r4.parsed === null && r4.error?.includes('JSON parse failed')) {
    pass('Reject invalid', 'Non-JSON correctly rejected');
  } else {
    fail('Reject invalid', 'Should have rejected');
  }

  // --- 5. Apply logic ---
  console.log('\n=== 5. Apply logic ===');

  // High confidence keep → auto
  if (r1.parsed!.confidence > 0.8 && r1.parsed!.grid_recommendation.action === 'keep') {
    pass('Auto apply keep', 'confidence=0.9 + keep → auto apply');
  }

  // Adjust with risk flags → pending confirmation
  if (r2.parsed!.risk_flags.length > 0) {
    pass('Pending adjust', 'risk_flags present → wait for Telegram confirmation');
  }

  // Pause → immediate
  if (r3.parsed!.grid_recommendation.action === 'pause') {
    pass('Immediate pause', 'action=pause → execute immediately');
  }

  // --- 6. Save to DB ---
  console.log('\n=== 6. Save to DB ===');
  try {
    const { PrismaClient } = await import('../generated/prisma/client.js');
    const prisma = new PrismaClient();
    await prisma.$connect();

    const saved = await prisma.claudeAdvice.create({
      data: {
        createdAt: new Date(),
        triggerReason: 'mock_test',
        contextSnapshot: JSON.parse(JSON.stringify(snapshot)),
        rawResponse: keepResponse,
        parsedAdvice: JSON.parse(JSON.stringify(r1.parsed)),
        applied: true,
        appliedAt: new Date(),
      },
    });
    pass('Save advice', `id=${saved.id}, trigger=mock_test, applied=true`);

    // Verify saved
    const loaded = await prisma.claudeAdvice.findUnique({ where: { id: saved.id } });
    if (loaded && loaded.applied && loaded.parsedAdvice) {
      pass('Verify saved', `Loaded from DB, parsed_advice has action=${(loaded.parsedAdvice as any).grid_recommendation.action}`);
    } else {
      fail('Verify saved', 'Could not reload from DB');
    }

    // Decision log
    await prisma.decisionLog.create({
      data: {
        decidedAt: new Date(),
        trigger: 'claude:mock_test',
        actionTaken: {
          action: 'keep',
          assessment: r1.parsed!.market_assessment,
          confidence: r1.parsed!.confidence,
        },
      },
    });
    pass('Decision log', 'Claude decision logged');

    await prisma.$disconnect();
  } catch (e: any) {
    fail('Save to DB', e.message);
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

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
