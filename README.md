# Crypto Grid Bot

Автоматический grid trading бот с rule-based классификатором рынка и Claude AI как стратегическим советником.

## Стек

- **Runtime**: Node.js 20+ / NestJS
- **БД**: PostgreSQL 16 / Prisma
- **Биржа**: ccxt (Binance)
- **Индикаторы**: technicalindicators (ADX, RSI, MACD, ATR, Bollinger Bands)
- **AI советник**: Claude API (@anthropic-ai/sdk)
- **Уведомления**: Telegram (telegraf)
- **Деплой**: PM2 + VPS

## Как работает

```
Binance API (REST polling)
        ↓
  Data Collector         ← OHLCV, баланс, orderbook каждые 30-60с
        ↓
   PostgreSQL
        ↓
  Market Classifier      ← flat / uptrend / downtrend / volatile
        ↓
  Grid Bot Engine        ← выставляет/отслеживает ордера
        ↓
  Risk Management        ← hard stops по drawdown и цене
        ↓
  Claude Advisor         ← анализ каждые 4ч + по триггерам
        ↓
  Telegram Bot           ← алерты, /status, /pnl, /pause, /resume
```

## Возможности

- Grid торговля с автоматическим расчётом диапазона через ATR
- Rule-based классификатор режима рынка (4 режима)
- Hard stop по дневному drawdown (-5%) и недельному (-15%)
- Остановка при выходе цены за сетку > 3%
- Position sizing: 60% активно / 30% резерв / 10% буфер
- Claude API советник с JSON рекомендациями
- Startup reconciliation — бот восстанавливает состояние после перезапуска
- Автозапуск сетки при старте если нет активной
- Telegram: алерты, команды управления, ежедневный отчёт
- Авторизация в Telegram по username

## Быстрый старт

### Требования

- Node.js 20+
- PostgreSQL 16
- Binance API ключи
- Claude API ключ
- Telegram Bot Token

### Установка

```bash
git clone https://github.com/RuslanPostnikov/grid-bot-rp.git
cd grid-bot-rp
yarn install
cp .env.example .env  # заполни переменные
npx prisma generate
npx prisma migrate deploy
npm run start:dev
```

### Переменные окружения

| Переменная | Описание |
|-----------|---------|
| `DATABASE_URL` | PostgreSQL connection string |
| `EXCHANGE_ID` | Биржа (binance) |
| `EXCHANGE_API_KEY` | API ключ биржи |
| `EXCHANGE_API_SECRET` | API секрет биржи |
| `EXCHANGE_TESTNET` | true/false |
| `TRADING_PAIR` | Торговая пара (ETH/USDT, BTC/USDT) |
| `CLAUDE_API_KEY` | Ключ Anthropic API |
| `TELEGRAM_BOT_TOKEN` | Токен Telegram бота |
| `TELEGRAM_CHAT_ID` | Твой Telegram chat ID |
| `TELEGRAM_ALLOWED_USERS` | Список разрешённых username через запятую |

## Telegram команды

| Команда | Описание |
|---------|---------|
| `/status` | Текущее состояние сетки и риски |
| `/pnl` | Статистика прибыли за 24ч и 7 дней |
| `/pause` | Остановить бота, отменить все ордера |
| `/resume` | Снять risk-паузу |
| `/advice` | Последний совет Claude |

## Деплой

См. [DEPLOY.md](DEPLOY.md)

## Тесты

```bash
npm test                              # unit тесты
npx tsx scripts/integration-test.ts  # интеграционный тест биржи
npx tsx scripts/test-stage9-testnet.ts  # полный тест на testnet
```
