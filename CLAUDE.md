# Crypto Grid Bot — Claude Code Context

## Проект
Автоматический grid trading бот для Binance с rule-based классификатором рынка
и Claude API как стратегическим советником. Торгует SOL/USDT на реальном аккаунте (~$14 капитал).

## Стек
- Node.js 20+ / NestJS
- PostgreSQL 16 / Prisma (8 моделей)
- ccxt (Binance REST API, polling)
- technicalindicators (ADX, EMA, ATR, BB, RSI, MACD)
- @anthropic-ai/sdk (Claude советник, модель claude-sonnet-4)
- telegraf (Telegram бот — управление и алерты)
- pm2 + VPS (деплой через scripts/deploy.sh)

## Правила разработки
- TypeScript strict mode везде
- Все секреты только в .env, никогда в коде
- Логировать каждое решение бота в таблицу decision_log
- Hard stops реализованы в коде, не обсуждаются
- Каждый модуль — отдельный NestJS module
- Обработка ошибок и retry на каждом внешнем вызове
- Ответы пользователю на русском
- Объяснять проблему перед тем как исправлять
- Не делать коммиты и пуши без явной просьбы

## Текущий этап
Бот в проде, торгует реальными деньгами. Основной функционал реализован.

---

## Архитектура и поток данных

```
Binance API (REST polling 15-60s)
      ↓
Collector (candles 1h/4h, orderbook, balance)
      ↓
PostgreSQL (Candle, MarketRegime)
      ↓
ML Service (rule-based классификатор → flat/uptrend/downtrend/volatile)
      ↓
Claude Advisor (каждые 4ч + по событиям → keep/adjust/pause/restart)
      ↓
Risk Service (drawdown, price deviation → NORMAL/WARNING/PAUSE/STOP)
      ↓
Grid Service (place/track/fill ордера, counter-orders)
      ↓
Trade DB + Telegram (уведомления, /status, /pnl, /pause, /resume)
```

Модули общаются через **EventEmitter2** (NestJS events). Ключевые события:
- `ORDER_FILLED` — ордер исполнен
- `RISK_WARNING` / `RISK_PAUSE` — проблемы с риском
- `PRICE_OUT_OF_RANGE` — цена вышла за сетку
- `REGIME_CHANGE` — смена режима рынка
- `BOT_RESUMED` — бот возобновлён (авто или ручной)
- `CLAUDE_ADVICE_PENDING` — совет Claude ждёт подтверждения в Telegram

---

## Модули — что реализовано

### BotOrchestrator (`src/bot-orchestrator.service.ts`)
- Автозапуск грида при старте приложения (ATR-based параметры)
- Перезапуск при `BOT_RESUMED` (авто-резюм или `/resume`)
- Retry: 10 попыток × 10с при неудаче
- Использует 1h свечи для ATR(14), текущую цену и баланс

### Grid (`src/modules/grid/`)
- **grid.service.ts** — полный lifecycle: setup → place orders → poll fills → counter-orders → cancel
- **grid-calculator.ts** — расчёт параметров грида по волатильности:
  - LOW vol: step 0.5-0.8%, ATR×2
  - NORMAL: step 1.0-1.5%, ATR×3
  - HIGH: step 2.0-2.5%, ATR×4
- **Стратегия USDT-only**: при setup выставляются только buy ордера, sell создаётся автоматически при исполнении buy (onBuyFilled)
- Polling ордеров каждые 15с, обработка partial fills
- Reconciliation при рестарте: сравнение DB vs exchange
- Orphaned position recovery: обнаружение оставшейся крипты, авто-продажа
- Персистентность ордеров в таблице `GridOrder` (статус, exchangeOrderId, gridCycleId)
- Обработка Binance -2011 (Unknown order) при cancel → проверка fill

**Заглушки:**
- `checkRebalanceTriggers()` и `calculateRebalance()` — функции существуют но НЕ вызываются. Нужны для автоматического сдвига грида при долгом нахождении цены в крайних зонах.
- Fee rate захардкожен 0.1% (должен быть из конфига или exchange.getTradingFees())

### Risk (`src/modules/risk/`)
- Проверка каждые 30с: daily/weekly drawdown + price deviation
- Уровни: NORMAL → WARNING (3% DD) → PAUSE (5% DD или price dev ≥ 5%) → STOP (15% weekly DD)
- Баланс = USDT + крипта × цену (предотвращает ложные drawdown при buy fill)
- Manual pause (`/pause`) — только `/resume` может снять, авто-резюм не сработает
- Auto-resume при RISK PAUSE: когда risk возвращается в NORMAL, эмитит `BOT_RESUMED`
- Кулдаун 5 минут между авто-резюмами (защита от цикла pause→resume→pause)
- Конфиг: activeCapitalPct, reserveCapitalPct, minBufferPct, maxPriceDeviationPct (всё из .env)

### Collector (`src/modules/collector/`)
- Polling: свечи каждые 60с (1h + 4h), orderbook каждые 30с, баланс каждые 60с
- Backfill при старте: 100 свечей если в БД < 60
- Non-blocking init через `setImmediate()`
- Запуск ML классификации каждые 4ч и при старте

### ML (`src/modules/ml/`)
- **Rule-based классификатор** (не нейросеть): ADX, EMA20/50, ATR, BB, RSI, MACD, Volume ratio
- 4 режима: `flat` (RUN_GRID), `uptrend` (SHIFT_UP), `downtrend` (PAUSE), `volatile` (WIDEN_GRID)
- Scoring: каждый индикатор даёт очки режиму, побеждает набравший больше
- Confidence = разница между winner и runner-up
- Сохраняет в `MarketRegime` с features JSON
- Нужно min 60 свечей для расчёта (EMA50 + buffer)

**Заглушки:**
- `regimeToAction()` возвращает GridAction (RUN_GRID, SHIFT_UP и т.д.) — но эти actions нигде не используются для реальных изменений грида

### Claude (`src/modules/claude/`)
- Запрос каждые 4ч + по событиям (PRICE_OUT_OF_RANGE, RISK_WARNING, REGIME_CHANGE)
- Модель: claude-sonnet-4, max 1024 tokens
- Snapshot: цена, баланс, трейды 24ч, режим, индикаторы, risk level
- Actions: keep, adjust, pause, restart
- Логика применения:
  - `pause` → немедленно отменяет грид
  - `keep` с confidence > 0.8 → применяется без подтверждения
  - `adjust`/`restart` → отменяет грид + `BOT_RESUMED` (BotOrchestrator пересоздаёт с новыми параметрами)
  - Низкая уверенность или risk_flags → отправляет в Telegram на подтверждение
- Все решения логируются в `ClaudeAdvice` и `DecisionLog`

**Заглушки:**
- Claude может предложить конкретные bounds/step, но бот их игнорирует — просто пересоздаёт грид по ATR. Нужен `setupGridWithParams()` для точного применения рекомендаций.

### Telegram (`src/modules/telegram/`)
- Команды: `/start`, `/status`, `/pnl`, `/pause`, `/resume`, `/advice`
- Алерты: 8 типов событий (risk, fills, regime, Claude advice)
- Inline кнопки: Apply/Reject совет Claude
- Daily report в 00:00 UTC (PnL за 24ч)
- Heartbeat каждые 15 мин
- Auth: проверка allowedUsers

### Exchange (`src/modules/exchange/`)
- Обёртка над ccxt для Binance
- Sandbox mode через `exchange.testnet=true`
- Rate limiting включён

---

## БД — Prisma модели

| Модель | Назначение | Статус |
|--------|-----------|--------|
| Candle | OHLCV свечи (1h, 4h) | ✅ Работает |
| MarketRegime | Результаты классификации | ✅ Работает |
| GridState | Конфиг активного грида | ✅ Работает |
| GridOrder | Ордера с exchangeOrderId | ✅ Работает |
| Trade | Исполненные сделки с PnL | ✅ Работает |
| ClaudeAdvice | Рекомендации Claude | ✅ Работает |
| DecisionLog | Аудит всех решений бота | ✅ Работает |
| BotPerformance | Сводные метрики | ⚠️ Поля nullable, не заполняется |

---

## Конфигурация (.env)

```
DATABASE_URL                   # PostgreSQL
EXCHANGE_API_KEY / SECRET      # Binance
EXCHANGE_TESTNET=false         # true для sandbox
EXCHANGE_TRADING_PAIR=SOL/USDT # торговая пара
CLAUDE_API_KEY                 # Anthropic
TELEGRAM_BOT_TOKEN             # Telegram бот
TELEGRAM_CHAT_ID               # Chat ID
TELEGRAM_ALLOWED_USERS         # CSV usernames
RISK_ACTIVE_CAPITAL_PCT=90     # % капитала для грида
RISK_RESERVE_CAPITAL_PCT=5     # резерв
RISK_MIN_BUFFER_PCT=5          # буфер безопасности
RISK_MAX_PRICE_DEVIATION_PCT=5 # порог отклонения цены
```

---

## Ключевые константы (захардкожены)

| Константа | Значение | Где |
|-----------|---------|-----|
| ORDER_POLL_MS | 15с | grid.service.ts |
| RISK_CHECK_INTERVAL_MS | 30с | risk.service.ts |
| BALANCE_SNAPSHOT_INTERVAL_MS | 60с | risk.service.ts |
| AUTO_RESUME_COOLDOWN_MS | 5 мин | risk.service.ts |
| CANDLE_POLL_MS | 60с | collector.service.ts |
| REGIME_CLASSIFY_MS | 4ч | collector.service.ts |
| SCHEDULED_INTERVAL_MS (Claude) | 4ч | claude.service.ts |
| MIN_ORDER_NOTIONAL_USDT | $6 | grid-calculator.ts |
| FEE_RATE | 0.1% | grid.service.ts |
| ATR_PERIOD | 14 | bot-orchestrator, grid-calculator |

---

## Тесты

**Unit (Jest):** grid.service, grid-calculator, risk-calculator, regime-classifier, claude-prompt, collector.service
**Integration (scripts/):** test-grid-lifecycle, test-order-persistence, test-risk, test-claude, test-telegram, integration-test

---

## Известные ограничения

1. **REST polling only** — нет WebSocket, задержка обнаружения fill до 15с
2. **Одна торговая пара** — архитектура поддерживает, но UI и orchestrator заточены под single pair
3. **Rebalancing не реализован** — грид не сдвигается при движении цены, только пересоздаётся при PAUSE→RESUME
4. **Claude не может задать точные параметры грида** — adjust/restart просто пересоздаёт по ATR
5. **BotPerformance не заполняется** — таблица есть, логика нет
6. **pnlAfter1h/pnlAfter24h в DecisionLog** — поля есть, никогда не заполняются

## Структура модулей
src/modules/exchange, collector, grid, ml, claude, risk, telegram, performance
