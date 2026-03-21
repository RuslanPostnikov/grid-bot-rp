// @ts-nocheck
/**
 * Integration test: Telegram Bot.
 *
 * 1. Подключение к Telegram API
 * 2. Отправка сообщения
 * 3. Отправка HTML-форматированного статуса
 * 4. Отправка сообщения с inline кнопками
 * 5. Проверка команд (регистрация)
 *
 * Запуск: npx tsx scripts/test-telegram.ts
 */

import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';

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

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log('❌ TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set');
    process.exit(1);
  }

  // --- 1. Init bot ---
  console.log('\n=== 1. Init Telegram bot ===');
  let bot: Telegraf;
  try {
    bot = new Telegraf(token);
    const me = await bot.telegram.getMe();
    pass('Init bot', `@${me.username} (id: ${me.id})`);
  } catch (e: any) {
    fail('Init bot', e.message);
    process.exit(1);
  }

  // --- 2. Send plain message ---
  console.log('\n=== 2. Send plain message ===');
  try {
    await bot.telegram.sendMessage(chatId, '🤖 Grid Bot integration test started');
    pass('Send message', 'Plain text sent');
  } catch (e: any) {
    fail('Send message', e.message);
  }

  // --- 3. Send HTML status ---
  console.log('\n=== 3. Send HTML status ===');
  try {
    const statusMsg = [
      `<b>📊 Status</b>`,
      ``,
      `💰 Пара: BTC/USDT`,
      `📈 Цена: $70,605.00`,
      `🔋 Grid: ✅ Active`,
      `📐 Диапазон: $67,000 — $74,000`,
      `📏 Шаг: 1.25%`,
      `📋 Ордеров: 10`,
      ``,
      `<b>⚠️ Risk</b>`,
      `Level: NORMAL`,
      `Daily DD: 0.8%`,
      `Weekly DD: 1.5%`,
      `Balance: $10,000.00`,
    ].join('\n');

    await bot.telegram.sendMessage(chatId, statusMsg, { parse_mode: 'HTML' });
    pass('Send HTML status', 'Formatted status sent');
  } catch (e: any) {
    fail('Send HTML status', e.message);
  }

  // --- 4. Send PnL report ---
  console.log('\n=== 4. Send PnL report ===');
  try {
    const pnlMsg = [
      `<b>💰 PnL Report</b>`,
      ``,
      `<b>24ч:</b>`,
      `  Сделок: 12 (6 циклов)`,
      `  PnL: $8.50`,
      `  Fees: $1.20`,
      `  Win rate: 100%`,
      ``,
      `<b>7 дней:</b>`,
      `  Сделок: 84`,
      `  PnL: $42.30`,
      `  Fees: $8.40`,
    ].join('\n');

    await bot.telegram.sendMessage(chatId, pnlMsg, { parse_mode: 'HTML' });
    pass('Send PnL report', 'PnL report sent');
  } catch (e: any) {
    fail('Send PnL report', e.message);
  }

  // --- 5. Send risk alert ---
  console.log('\n=== 5. Send risk alert ===');
  try {
    await bot.telegram.sendMessage(
      chatId,
      `⚠️ <b>RISK WARNING</b>\n\nDaily drawdown 3.5% >= warning threshold 3%\nDaily DD: 3.5%`,
      { parse_mode: 'HTML' },
    );
    pass('Risk alert', 'Warning alert sent');
  } catch (e: any) {
    fail('Risk alert', e.message);
  }

  // --- 6. Send Claude advice with buttons ---
  console.log('\n=== 6. Send Claude advice with buttons ===');
  try {
    const adviceMsg =
      `🧠 <b>Claude рекомендует: ADJUST</b>\n\n` +
      `📊 Рынок начинает trending вверх\n` +
      `💡 Сдвинуть сетку вверх на 3%\n` +
      `📈 Уверенность: 75%`;

    await bot.telegram.sendMessage(chatId, adviceMsg, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        Markup.button.callback('✅ Применить', 'apply_advice:test_123'),
        Markup.button.callback('❌ Отклонить', 'reject_advice:test_123'),
      ]),
    });
    pass('Claude advice buttons', 'Advice with inline buttons sent');
  } catch (e: any) {
    fail('Claude advice buttons', e.message);
  }

  // --- 7. Send completion message ---
  console.log('\n=== 7. Send completion ===');
  try {
    await bot.telegram.sendMessage(
      chatId,
      '✅ Integration test complete! Bot is ready.',
    );
    pass('Completion', 'Final message sent');
  } catch (e: any) {
    fail('Completion', e.message);
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
