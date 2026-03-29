// @ts-nocheck
/**
 * Integration test: команда /sell (manual market sell).
 *
 * 1. Получение баланса и цены (getBaseAssetSellInfo logic)
 * 2. Проверка минимального нотионала
 * 3. Отправка превью в Telegram с кнопками
 * 4. (Опционально) Реальный market sell — раскомментируй шаг 4
 *
 * Запуск: npx tsx scripts/test-sell-command.ts
 */

import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';

const MIN_ORDER_NOTIONAL_USDT = 6;

async function main() {
  const results: { test: string; status: 'PASS' | 'FAIL'; detail: string }[] =
    [];

  function pass(test: string, detail: string) {
    results.push({ test, status: 'PASS', detail });
    console.log(`  ✅ ${test}: ${detail}`);
  }
  function fail(test: string, detail: string) {
    results.push({ test, status: 'FAIL', detail });
    console.log(`  ❌ ${test}: ${detail}`);
  }

  const pair = process.env.TRADING_PAIR ?? 'SOL/USDT';
  const baseAsset = pair.split('/')[0];

  // --- 1. Init exchange ---
  console.log('\n=== 1. Init exchange ===');
  const ccxt = await import('ccxt');
  const exchange = new ccxt.binance({
    apiKey: process.env.EXCHANGE_API_KEY,
    secret: process.env.EXCHANGE_API_SECRET,
    enableRateLimit: true,
  });

  const testnet = process.env.EXCHANGE_TESTNET === 'true';
  if (testnet) {
    exchange.setSandboxMode(true);
  }
  pass('Init exchange', `binance (testnet: ${testnet})`);

  // --- 2. Get balance and price (same as getBaseAssetSellInfo) ---
  console.log('\n=== 2. Get sell info ===');
  let freeBase: number;
  let price: number;
  let roundedQty: number;
  let notional: number;

  try {
    const [balance, ticker] = await Promise.all([
      exchange.fetchBalance(),
      exchange.fetchTicker(pair),
    ]);

    freeBase = Number(
      balance.free?.[baseAsset] ??
        balance.free?.[baseAsset.toLowerCase()] ??
        0,
    );
    price = ticker.last ?? 0;
    roundedQty = Math.round(freeBase * 100000) / 100000;
    notional = roundedQty * price;

    console.log(`  ${baseAsset} free: ${freeBase}`);
    console.log(`  ${baseAsset} rounded: ${roundedQty}`);
    console.log(`  Price: $${price.toFixed(2)}`);
    console.log(`  Notional: $${notional.toFixed(2)}`);

    pass('Get sell info', `${roundedQty} ${baseAsset} @ $${price.toFixed(2)} = $${notional.toFixed(2)}`);
  } catch (e: any) {
    fail('Get sell info', e.message);
    process.exit(1);
  }

  // --- 3. Check minimum notional ---
  console.log('\n=== 3. Check minimum notional ===');
  const canSell = roundedQty > 0 && notional >= MIN_ORDER_NOTIONAL_USDT;
  if (canSell) {
    pass('Min notional', `$${notional.toFixed(2)} >= $${MIN_ORDER_NOTIONAL_USDT} — можно продать`);
  } else {
    pass(
      'Min notional',
      `$${notional.toFixed(2)} < $${MIN_ORDER_NOTIONAL_USDT} — нечего продавать (это ОК если нет ${baseAsset})`,
    );
  }

  // --- 4. Send Telegram preview ---
  console.log('\n=== 4. Send Telegram preview ===');
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    fail('Telegram preview', 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set');
  } else {
    try {
      const bot = new Telegraf(token);

      if (canSell) {
        await bot.telegram.sendMessage(
          chatId,
          `🧪 <b>TEST /sell</b>\n\n` +
            `🔴 <b>Продать ${baseAsset}?</b>\n\n` +
            `Кол-во: ${roundedQty} ${baseAsset}\n` +
            `Цена: ~$${price.toFixed(2)}\n` +
            `Сумма: ~$${notional.toFixed(2)}\n\n` +
            `<i>(тестовое сообщение, кнопки не работают)</i>`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              Markup.button.callback('✅ Продать', 'test_confirm_sell'),
              Markup.button.callback('❌ Отмена', 'test_cancel_sell'),
            ]),
          },
        );
        pass('Telegram preview', 'Sell confirmation preview sent');
      } else {
        await bot.telegram.sendMessage(
          chatId,
          `🧪 <b>TEST /sell</b>\n\n` +
            `ℹ️ Нечего продавать: ${freeBase.toFixed(5)} ${baseAsset} (~$${notional.toFixed(2)})`,
          { parse_mode: 'HTML' },
        );
        pass('Telegram preview', 'Empty balance message sent');
      }
    } catch (e: any) {
      fail('Telegram preview', e.message);
    }
  }

  // --- 5. (OPTIONAL) Real market sell — uncomment to test ---
  // console.log('\n=== 5. Real market sell ===');
  // if (canSell) {
  //   try {
  //     const order = await exchange.createOrder(pair, 'market', 'sell', roundedQty);
  //     const filledPrice = Number(order.average ?? order.price ?? 0);
  //     const filledQty = Number(order.filled ?? roundedQty);
  //     const total = filledPrice * filledQty;
  //     pass('Market sell', `${filledQty} ${baseAsset} @ $${filledPrice.toFixed(2)} = $${total.toFixed(2)}`);
  //   } catch (e: any) {
  //     fail('Market sell', e.message);
  //   }
  // } else {
  //   pass('Market sell', 'Skipped — nothing to sell');
  // }

  // --- Summary ---
  console.log('\n═══════════════════════════════════════');
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(
    `Results: ${passed} passed, ${failed} failed out of ${results.length}`,
  );
  if (failed > 0) {
    console.log('\nFailed:');
    results
      .filter((r) => r.status === 'FAIL')
      .forEach((r) => console.log(`  ❌ ${r.test}: ${r.detail}`));
  }
  console.log('═══════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
