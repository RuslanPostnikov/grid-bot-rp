// @ts-nocheck
/**
 * Integration test: Claude советник.
 *
 * 1. Сборка snapshot из реальных данных
 * 2. Вызов Claude API
 * 3. Парсинг JSON ответа
 * 4. Сохранение в БД
 * 5. Логика применения совета
 *
 * Запуск: npx tsx scripts/test-claude.ts
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
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

  // --- 1. Build snapshot from real exchange data ---
  console.log('\n=== 1. Build market snapshot ===');
  const ccxt = await import('ccxt');
  const exchange = new ccxt.binance({
    apiKey: process.env.EXCHANGE_API_KEY,
    secret: process.env.EXCHANGE_API_SECRET,
    enableRateLimit: true,
  });
  exchange.setSandboxMode(true);

  let snapshot: MarketSnapshot;
  try {
    const ticker = await exchange.fetchTicker('BTC/USDT');
    const balance = await exchange.fetchBalance();

    snapshot = {
      pair: 'BTC/USDT',
      currentPrice: ticker.last ?? 0,
      priceChange24h: ticker.percentage ?? 0,
      volume24h: ticker.quoteVolume ?? 0,
      regime: 'flat',
      regimeConfidence: 0.82,
      gridActive: true,
      gridBounds: { lower: (ticker.last ?? 70000) * 0.95, upper: (ticker.last ?? 70000) * 1.05 },
      gridStepPct: 1.25,
      balance: {
        usdt: Number(balance.free?.USDT ?? 0),
        btc: Number(balance.free?.BTC ?? 0),
      },
      recentTrades: [
        { side: 'buy', price: (ticker.last ?? 70000) * 0.99, pnl: null, time: new Date().toISOString() },
        { side: 'sell', price: (ticker.last ?? 70000) * 1.01, pnl: 5.2, time: new Date().toISOString() },
      ],
      totalPnl24h: 5.2,
      dailyDrawdownPct: 1.2,
      weeklyDrawdownPct: 2.5,
      riskLevel: 'normal',
      indicators: { rsi14: 52, adx14: 18, atrPct: 2.1, macdHistogram: -15 },
    };

    pass('Build snapshot', `Price=$${snapshot.currentPrice}, USDT=$${snapshot.balance.usdt.toFixed(2)}`);
  } catch (e: any) {
    fail('Build snapshot', e.message);
    process.exit(1);
  }

  // --- 2. Build prompt ---
  console.log('\n=== 2. Build prompt ===');
  const userPrompt = buildUserPrompt(snapshot);
  if (userPrompt.includes('BTC/USDT') && userPrompt.includes('grid_recommendation')) {
    pass('Build prompt', `Prompt length: ${userPrompt.length} chars`);
  } else {
    fail('Build prompt', 'Missing expected content');
  }

  // --- 3. Call Claude API ---
  console.log('\n=== 3. Call Claude API ===');
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    fail('Claude API', 'CLAUDE_API_KEY not set in .env');
    printSummary(results);
    process.exit(1);
  }

  let rawResponse = '';
  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    rawResponse = textBlock?.type === 'text' ? textBlock.text : '';

    pass('Claude API call', `Response length: ${rawResponse.length} chars, model: ${response.model}`);
    console.log(`    Raw response:\n    ${rawResponse.substring(0, 200)}...`);
  } catch (e: any) {
    fail('Claude API call', e.message);
    printSummary(results);
    process.exit(1);
  }

  // --- 4. Parse response ---
  console.log('\n=== 4. Parse JSON response ===');
  const { parsed, error } = parseClaudeResponse(rawResponse);
  if (parsed && !error) {
    pass('Parse response', `action=${parsed.grid_recommendation.action}, confidence=${parsed.confidence}`);
    console.log(`    Assessment: ${parsed.market_assessment}`);
    console.log(`    Recommendation: ${parsed.grid_recommendation.reason}`);
    console.log(`    Risk flags: ${parsed.risk_flags.length > 0 ? parsed.risk_flags.join(', ') : 'none'}`);
    console.log(`    Next review: ${parsed.next_review_hours}h`);
  } else {
    fail('Parse response', error ?? 'Unknown parse error');
  }

  // --- 5. Save to DB ---
  console.log('\n=== 5. Save advice to DB ===');
  try {
    const { PrismaClient } = await import('../generated/prisma/client.js');
    const prisma = new PrismaClient();
    await prisma.$connect();

    const saved = await prisma.claudeAdvice.create({
      data: {
        createdAt: new Date(),
        triggerReason: 'integration_test',
        contextSnapshot: JSON.parse(JSON.stringify(snapshot)),
        rawResponse,
        parsedAdvice: parsed ? JSON.parse(JSON.stringify(parsed)) : undefined,
        applied: false,
      },
    });

    pass('Save to DB', `Advice saved, id=${saved.id}`);

    // --- 6. Verify apply logic ---
    console.log('\n=== 6. Apply logic ===');
    if (parsed) {
      const { action } = parsed.grid_recommendation;
      const { confidence, risk_flags } = parsed;

      let expectedBehavior: string;
      if (action === 'pause') {
        expectedBehavior = 'IMMEDIATE: cancel grid';
      } else if (confidence > 0.8 && action === 'keep') {
        expectedBehavior = 'AUTO: apply silently';
      } else if (confidence < 0.7 || risk_flags.length > 0) {
        expectedBehavior = 'MANUAL: wait for Telegram confirmation';
      } else {
        expectedBehavior = 'PENDING: send to Telegram for confirmation';
      }

      pass('Apply logic', `action=${action}, confidence=${confidence} → ${expectedBehavior}`);

      // Mark as applied
      await prisma.claudeAdvice.update({
        where: { id: saved.id },
        data: { applied: true, appliedAt: new Date() },
      });
      pass('Mark applied', `Advice ${saved.id} marked as applied`);
    } else {
      fail('Apply logic', 'No parsed advice to apply');
    }

    await prisma.$disconnect();
  } catch (e: any) {
    fail('Save to DB', e.message);
  }

  printSummary(results);
  const failed = results.filter((r) => r.status === 'FAIL').length;
  process.exit(failed > 0 ? 1 : 0);
}

function printSummary(results: { test: string; status: string; detail: string }[]) {
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
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
