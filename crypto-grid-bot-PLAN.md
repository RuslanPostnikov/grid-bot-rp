# 🤖 Crypto Grid Bot — Детальный план разработки

> **Стек:** Node.js · NestJS · PostgreSQL · ccxt · Claude API · Telegram
> **Цель:** Grid-бот с rule-based классификатором рынка и Claude как стратегическим советником
> **Дата:** Март 2026

---

## 📋 Содержание

1. [Архитектура](#1-архитектура)
2. [Стек технологий](#2-стек-технологий)
3. [Схема БД](#3-схема-бд)
4. [Этапы разработки](#4-этапы-разработки)
5. [Логика бота](#5-логика-бота)
6. [Классификатор режима рынка](#6-классификатор-режима-рынка)
7. [Интеграция Claude](#7-интеграция-claude)
8. [Risk Management](#8-risk-management)
9. [Telegram](#9-telegram)
10. [Бэктестинг](#10-бэктестинг)
11. [Деплой](#11-деплой)
12. [Чеклист запуска](#12-чеклист-запуска)
13. [Прогноз по капиталу](#13-прогноз-по-капиталу)

---

## 1. Архитектура

```
┌──────────────────────────────────────────────────────┐
│              Биржа (Binance / Bybit)                  │
│               REST API (polling)                      │
└─────────────────────┬────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────────────┐
│               Data Collector (NestJS)                 │
│   OHLCV · Orderbook · Trades · Баланс · Позиции      │
└─────────────────────┬────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────────────┐
│                  PostgreSQL                           │
│  candles · trades · grid_state · market_regime       │
│  bot_performance · claude_advice · decision_log      │
└──────┬───────────────────────────┬───────────────────┘
       │                           │
       ▼                           ▼
┌─────────────┐         ┌─────────────────────────────┐
│  Market     │         │      Grid Bot Engine        │
│  Regime     │         │                             │
│  Classifier │────────▶│  Управление сеткой          │
│  (rule-     │         │  Исполнение ордеров         │
│  based)     │         │  Авто-ребаланс              │
└─────────────┘         └──────────────┬──────────────┘
                                       │
                    ┌──────────────────▼──────────────┐
                    │      Claude Consultant           │
                    │   (каждые 4ч + по триггерам)    │
                    │                                 │
                    │  Анализ → JSON рекомендации     │
                    └──────────────┬──────────────────┘
                                   │
                    ┌──────────────▼──────────────────┐
                    │         Telegram Bot             │
                    │  Алерты · /status · Подтвержд.  │
                    └─────────────────────────────────┘
```

---

## 2. Стек технологий

| Слой | Технология | Зачем |
|------|-----------|-------|
| Runtime | Node.js 20+ | основа |
| Framework | NestJS | модульность, DI, удобство |
| БД | PostgreSQL 16 | хранение всего |
| ORM | Prisma | строгая типизация, миграции из коробки |
| Биржа | ccxt | единый интерфейс к 100+ биржам |
| Индикаторы | technicalindicators | RSI, MACD, ATR, Bollinger |
| Claude | @anthropic-ai/sdk | стратегический советник |
| Telegram | telegraf | алерты и управление |
| Деплой | pm2 + VPS | 24/7 работа |
| Тесты | Jest | unit + integration |

---

## 3. Схема БД

```sql
-- Свечи (OHLCV)
CREATE TABLE candles (
  id          BIGSERIAL PRIMARY KEY,
  pair        VARCHAR(20)   NOT NULL,
  timeframe   VARCHAR(5)    NOT NULL,
  open_time   TIMESTAMPTZ   NOT NULL,
  open        NUMERIC       NOT NULL,
  high        NUMERIC       NOT NULL,
  low         NUMERIC       NOT NULL,
  close       NUMERIC       NOT NULL,
  volume      NUMERIC       NOT NULL,
  UNIQUE(pair, timeframe, open_time)
);

-- Режим рынка от ML модели
CREATE TABLE market_regime (
  id           BIGSERIAL PRIMARY KEY,
  pair         VARCHAR(20)  NOT NULL,
  detected_at  TIMESTAMPTZ  NOT NULL,
  regime       VARCHAR(20)  NOT NULL,  -- flat/uptrend/downtrend/volatile
  confidence   NUMERIC      NOT NULL,  -- 0.0 - 1.0
  features     JSONB                   -- входные фичи модели
);

-- Состояние сетки
CREATE TABLE grid_state (
  id             BIGSERIAL PRIMARY KEY,
  pair           VARCHAR(20)  NOT NULL,
  updated_at     TIMESTAMPTZ  NOT NULL,
  lower_bound    NUMERIC      NOT NULL,
  upper_bound    NUMERIC      NOT NULL,
  grid_step_pct  NUMERIC      NOT NULL,
  levels_count   INT          NOT NULL,
  capital_usdt   NUMERIC      NOT NULL,
  active         BOOLEAN      DEFAULT false
);

-- Исполненные сделки
CREATE TABLE trades (
  id                BIGSERIAL PRIMARY KEY,
  pair              VARCHAR(20)  NOT NULL,
  executed_at       TIMESTAMPTZ  NOT NULL,
  side              VARCHAR(5)   NOT NULL,
  price             NUMERIC      NOT NULL,
  quantity          NUMERIC      NOT NULL,
  fee_usdt          NUMERIC      NOT NULL,
  pnl_usdt          NUMERIC,
  grid_cycle_id     VARCHAR(50),
  exchange_order_id VARCHAR(100)
);

-- Советы Claude
CREATE TABLE claude_advice (
  id               BIGSERIAL PRIMARY KEY,
  created_at       TIMESTAMPTZ  NOT NULL,
  trigger_reason   VARCHAR(50),
  context_snapshot JSONB,
  raw_response     TEXT,
  parsed_advice    JSONB,
  applied          BOOLEAN  DEFAULT false,
  applied_at       TIMESTAMPTZ
);

-- Лог всех решений бота
CREATE TABLE decision_log (
  id              BIGSERIAL PRIMARY KEY,
  decided_at      TIMESTAMPTZ  NOT NULL,
  trigger         VARCHAR(50),
  market_snapshot JSONB,
  ml_regime       VARCHAR(20),
  action_taken    JSONB,
  pnl_after_1h    NUMERIC,
  pnl_after_24h   NUMERIC
);

-- Производительность по периодам
CREATE TABLE bot_performance (
  id              BIGSERIAL PRIMARY KEY,
  period_start    TIMESTAMPTZ,
  period_end      TIMESTAMPTZ,
  pair            VARCHAR(20),
  total_trades    INT,
  profitable      INT,
  total_pnl_usdt  NUMERIC,
  fees_paid_usdt  NUMERIC,
  max_drawdown    NUMERIC,
  roi_pct         NUMERIC
);
```

---

## 4. Этапы разработки

### Этап 0 — Подготовка (1-2 дня)
- [ ] Инициализация NestJS проекта
- [ ] Настройка PostgreSQL + Prisma (схема, миграции)
- [ ] Настройка `.env` и конфигурационного модуля
- [ ] Регистрация аккаунта на бирже, получение API ключей
- [ ] Включить Testnet (Binance Testnet / Bybit Testnet)
- [ ] Настроить `ccxt` с testnet endpoints
- [ ] Настроить логгер (winston/pino)

### Этап 1 — Data Collector (2-3 дня)
- [ ] REST polling OHLCV свечей с биржи через ccxt (каждые 30-60 сек)
- [ ] Запись свечей в БД (1h, 4h)
- [ ] Сбор текущего orderbook (polling)
- [ ] Сбор баланса и открытых позиций
- [ ] Retry + error handling при network errors
- [ ] Rate limit middleware

> WebSocket (ccxt pro) — добавить позже как оптимизацию, когда базовая логика стабильна

### Этап 2 — Grid Core Logic (3-4 дня)
- [ ] Расчёт параметров сетки (диапазон, шаг, уровни) — чистые функции
- [ ] Логика цикла: buy исполнен → выставить sell выше
- [ ] Авто-ребаланс сетки по триггерам (чистая логика)
- [ ] Unit-тесты на все расчёты сетки

### Этап 3 — Backtesting модуль (3-4 дня)
- [ ] Загрузка исторических данных (минимум 12 месяцев)
- [ ] Симуляция grid-бота на истории (используя логику из Этапа 2)
- [ ] Учёт комиссий в расчётах (обязательно!)
- [ ] Вывод метрик: PnL, win rate, drawdown, Sharpe, ROI
- [ ] Сравнение с HODL стратегией
- [ ] Тест разных параметров сетки (оптимизация)

> Не переходить к Этапу 4 без успешного бэктеста

### Этап 4 — Rule-based классификатор режима рынка (2-3 дня)
- [ ] Расчёт фич из свечей (ADX, ATR, RSI, MACD, BB width, EMA diff, Volume ratio)
- [ ] Rule-based классификатор (на правилах, без ML)
- [ ] Запись режима в `market_regime` таблицу
- [ ] Тест классификатора на исторических данных
- [ ] Определение пороговых значений для каждого режима

### Этап 5 — Grid Bot Exchange Integration (4-5 дней)
- [ ] Выставление ордеров через ccxt (обвязка над core logic из Этапа 2)
- [ ] Трекинг статуса каждого ордера (polling)
- [ ] Обработка частичного исполнения ордера
- [ ] Обработка отмены ордеров биржей (maintenance, высокая волатильность)
- [ ] Startup reconciliation (сверка с биржей при старте)
- [ ] Защита от дублирования ордеров при рестарте

### Этап 6 — Risk Management (2 дня)
- [ ] Hard stop по дневному drawdown (-5%)
- [ ] Hard stop по недельному drawdown (-15%)
- [ ] Остановка при выходе цены за сетку > 3%
- [ ] Минимальный буферный баланс (10% неприкосновенно)
- [ ] Position sizing: 60% активно / 30% резерв / 10% буфер

### Этап 7 — Claude интеграция (2 дня)
- [ ] Сборка контекстного snapshot из БД
- [ ] Промпт с JSON-форматом ответа
- [ ] Парсинг и сохранение советов в БД
- [ ] Расписание вызовов (каждые 4 часа)
- [ ] Триггерные вызовы (выход за диапазон, drawdown, смена режима)
- [ ] Логика применения советов (авто или через Telegram подтверждение)

### Этап 8 — Telegram Bot (1-2 дня)
- [ ] Алерты о критических событиях
- [ ] Команда `/status` — текущее состояние
- [ ] Команда `/pnl` — статистика прибыли
- [ ] Команда `/pause` и `/resume` — управление ботом
- [ ] Кнопки подтверждения советов Claude
- [ ] Ежедневный отчёт в 00:00
- [ ] Heartbeat ping каждые 15 мин (алерт если пропущен — бот завис)

### Этап 9 — Тестирование на Testnet (2 недели)
- [ ] Полный прогон на testnet без реальных денег
- [ ] Проверка всех edge cases
- [ ] Проверка retry/error handling логики
- [ ] Проверка startup reconciliation
- [ ] Стресс-тест (имитация резких движений цены)
- [ ] Убедиться что все hard stops работают
- [ ] Проверка heartbeat и алертов при зависании

### Этап 10 — Деплой на прод (1 день)
- [ ] VPS настройка (Hetzner / DigitalOcean, ~$6/мес)
- [ ] Переключение на реальные API ключи
- [ ] IP whitelist на бирже
- [ ] pm2 для управления процессом
- [ ] Мониторинг логов
- [ ] Первый запуск с минимальным капиталом ($100-200)

---

## 5. Логика бота

### Параметры сетки

```
Входные данные:
  - Текущая цена (P)
  - ATR за 14 периодов (волатильность)
  - Доступный капитал

Расчёт диапазона:
  lower_bound = P - (ATR × 3)
  upper_bound = P + (ATR × 3)

Расчёт шага сетки:
  Нормальная волатильность: шаг = 1.0-1.5%
  Высокая волатильность:    шаг = 2.0-2.5%
  Низкая волатильность:     шаг = 0.5-0.8%

Количество уровней:
  levels = (upper_bound - lower_bound) / step
  Оптимально: 10-20 уровней
```

### Авто-ребаланс триггеры

```
По времени:
  Каждые 24 часа → пересчитать центр по EMA50

По цене:
  Цена в верхних 20% диапазона > 4 часов → сдвиг вверх
  Цена в нижних 20% диапазона > 4 часов → запрос Claude

По волатильности (ATR):
  ATR вырос > 50% от нормы → расширить шаг сетки
  ATR упал < 30% от нормы → сузить шаг сетки
```

### Действия по режиму рынка

```
flat        → RUN_GRID      (запускаем / продолжаем)
uptrend     → SHIFT_UP      (сдвигаем сетку вверх)
downtrend   → PAUSE         (останавливаем, ждём)
volatile    → WIDEN_GRID    (расширяем шаг сетки)
```

---

## 6. Классификатор режима рынка

### Фичи (считаются из свечей в БД)

```typescript
interface MarketFeatures {
  adx_14: number;          // < 25 = флэт, > 25 = тренд
  ema_diff_pct: number;    // (EMA20 - EMA50) / EMA50 × 100
  atr_pct: number;         // ATR / цена × 100
  bb_width: number;        // (upper - lower) / middle
  rsi_14: number;          // 0-100
  macd_histogram: number;
  volume_ratio: number;    // текущий объём / SMA объёма за 20
}
```

### Rule-based классификатор v1

```
FLAT если:
  adx_14 < 25
  AND abs(ema_diff_pct) < 0.5%
  AND bb_width < среднего bb_width

UPTREND если:
  adx_14 > 25
  AND ema_diff_pct > 0.5%
  AND rsi_14 > 55

DOWNTREND если:
  adx_14 > 25
  AND ema_diff_pct < -0.5%
  AND rsi_14 < 45

VOLATILE если:
  atr_pct > среднего atr_pct × 1.5
  OR volume_ratio > 2.0
```

### ML v2 (после 2-3 месяцев реальных данных, отдельный этап)
- Использовать `decision_log` как датасет
- Обучить RandomForest или XGBoost классификатор
- Заменить rule-based на обученную модель
- Не включено в первоначальный план — требует накопления данных

---

## 7. Интеграция Claude

### Периодичность вызовов

```
Плановые (каждые 4 часа):
  ~6 вызовов/день × $0.02 = $0.12/день = ~$3.6/мес

Триггерные (дополнительно):
  - Цена вышла за диапазон сетки
  - Drawdown превысил 3% за день
  - ML модель сменила режим рынка
  - Резкий рост объёма (> 3× среднего)

Итого в месяц: ~$7-10 на API ✅
```

### Структура промпта

```typescript
const systemPrompt = `
  Ты советник автоматического grid торгового бота на крипто бирже.
  Анализируй предоставленные данные и давай рекомендации.
  Отвечай ТОЛЬКО валидным JSON без markdown и пояснений.
`;

const userPrompt = `
  Данные за последние 24 часа:
  ${JSON.stringify(snapshot, null, 2)}
  
  Ответ строго в формате:
  {
    "market_assessment": "string",
    "grid_recommendation": {
      "action": "keep|adjust|pause|restart",
      "lower_bound": number | null,
      "upper_bound": number | null,
      "grid_step_pct": number | null,
      "reason": "string"
    },
    "risk_flags": ["string"],
    "confidence": 0.0-1.0,
    "next_review_hours": number
  }
`;
```

### Логика применения советов

```
confidence > 0.8 AND action = "keep"
  → применить автоматически, тихо логировать

confidence > 0.7 AND action = "adjust"
  → отправить в Telegram с кнопками [✅ Применить] [❌ Отклонить]
  → если нет ответа 30 минут → не применять

confidence < 0.7 OR risk_flags не пустые
  → только алерт в Telegram, не применять автоматически

action = "pause"
  → выполнить немедленно + алерт в Telegram
```

---

## 8. Risk Management

### Hard stops

```
Уровень 1 — предупреждение:
  Дневной drawdown > 3%     → алерт + запрос Claude

Уровень 2 — пауза:
  Дневной drawdown > 5%     → остановить бота + алерт
  Цена вышла за сетку > 3%  → остановить + запрос Claude

Уровень 3 — полная остановка:
  Недельный drawdown > 15%  → стоп + алерт + ждать команды
  Баланс < min_balance      → стоп + экстренный алерт
```

### Position sizing

```
Общий капитал: 100% (одна пара в v1)
├── 60% — активная сетка (торгует)
├── 30% — резерв (для ребаланса)
└── 10% — буфер (неприкосновенно)

Multi-pair — отдельный этап после 1+ месяца стабильной работы на одной паре
```

### Безопасность API ключей

```
✅ Только Read + Trade (никогда Withdraw)
✅ IP whitelist на бирже (только IP твоего VPS)
✅ Ключи в .env, никогда в коде и в git
✅ .env в .gitignore
✅ Rotate ключи каждые 90 дней
```

---

## 9. Telegram

### Команды

```
/status   — состояние бота (пара, диапазон, PnL сегодня)
/pnl      — статистика: день / неделя / месяц
/grid     — параметры текущей сетки
/advice   — последний совет Claude
/pause    — приостановить бота
/resume   — возобновить бота
/stop     — полная остановка (с подтверждением)
/report   — полный отчёт за 7 дней
```

### Автоматические алерты

```
🟢 Бот запущен / сетка выставлена
🔄 Выполнен цикл (buy + sell) → прибыль $X
⚠️  Цена близко к границе диапазона (< 1.5%)
🔴 Цена вышла за диапазон → бот на паузе
📊 Совет Claude: [action] + кнопки подтверждения
💸 Drawdown алерт: -X% за сегодня
🛑 Hard stop сработал: причина
📈 Ежедневный отчёт 00:00: PnL, циклов, комиссии
```

---

## 10. Бэктестинг

### Метрики

```
- Total PnL (с комиссиями и без)
- Win rate циклов сетки
- Avg profit per cycle
- Max drawdown
- Сколько раз цена выходила за диапазон
- Avg ROI в месяц
- Sharpe ratio
- Сравнение с HODL
```

### Правила бэктеста

```
✅ Всегда включать комиссии (0.1% per side = 0.2% round trip)
✅ Учитывать slippage (~0.05%)
✅ Тестировать на разных условиях отдельно:
    - Бычий рынок (2023 Q4)
    - Медвежий рынок (2022)
    - Боковик (разные периоды)
✅ Не оптимизировать под один период (overfitting)
✅ Минимум 12 месяцев исторических данных
```

---

## 11. Деплой

### Структура проекта

```
crypto-grid-bot/
├── src/
│   ├── modules/
│   │   ├── exchange/          # ccxt wrapper, rate limiting
│   │   ├── collector/         # сбор данных с биржи
│   │   ├── grid/              # логика сетки, ордера
│   │   ├── ml/                # классификатор режима рынка
│   │   ├── claude/            # интеграция Claude API
│   │   ├── risk/              # risk management
│   │   ├── telegram/          # telegram bot
│   │   └── performance/       # расчёт метрик
│   ├── prisma/
│   │   ├── schema.prisma
│   │   └── migrations/
│   ├── config/
│   └── main.ts
├── backtesting/
├── scripts/
├── logs/
├── CLAUDE.md                  # контекст для Claude Code
├── .env
├── .env.example
├── docker-compose.yml
├── ecosystem.config.js        # pm2
└── README.md
```

### VPS требования

```
CPU:   1 vCPU
RAM:   1-2 GB
Disk:  20 GB SSD
OS:    Ubuntu 22.04
Цена:  $5-6/мес (Hetzner CX11 / DigitalOcean Basic)
Регион: Frankfurt / Amsterdam (низкий пинг до Binance)
```

### pm2 конфигурация

```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'grid-bot',
    script: 'dist/main.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    error_file: 'logs/error.log',
    out_file: 'logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
};
```

---

## 12. Чеклист запуска

### Перед запуском на реальные деньги

```
Разработка:
  ✅ Бэктест показал положительный PnL с комиссиями
  ✅ Все hard stops протестированы
  ✅ Startup reconciliation работает
  ✅ Обработка всех network errors / timeout
  ✅ Retry logic работает при network errors
  ✅ Нет дублирования ордеров при рестарте

Безопасность:
  ✅ API ключи только Read + Trade (без Withdraw)
  ✅ IP whitelist настроен на бирже
  ✅ .env не в git репозитории
  ✅ min_balance буфер настроен

Тестирование:
  ✅ Testnet прогон минимум 2 недели
  ✅ Все Telegram алерты работают
  ✅ Claude вызовы работают, советы пишутся в БД
  ✅ Стресс-тест: имитация резкого движения цены

Первый запуск:
  ✅ Начать с $100-200 (не с полного капитала)
  ✅ Первые 3 дня наблюдать вручную
  ✅ Проверять логи каждые несколько часов
  ✅ Расширять капитал только после 2 недель стабильности
```

---

## 13. Прогноз по капиталу

| Капитал | Реалист. месяц (2-5%) | Риск drawdown | Рекомендация |
|---------|----------------------|---------------|--------------|
| $200-500 | $4-25 | -$50-150 | Обучение, не бизнес |
| $1,000-2,000 | $20-100 | -$200-600 | Первый реальный запуск |
| $5,000 | $100-250 | -$500-1,500 | Стабильная работа |
| $10,000 | $200-500 | -$1,000-3,000 | Серьёзный подход |

### Операционные расходы в месяц

```
VPS:          ~$6
Claude API:   ~$7-10
Итого:        ~$15-16/мес

Окупается при капитале от $300-500
```

### Условия хорошего месяца (боковик)
- Реалистичный ROI: 2-5%
- Оптимистичный ROI (идеальный боковик): 5-8%

### Условия плохого месяца (сильный тренд)
- Drawdown: -15% до -30%
- Бот на паузе, убытки ограничены hard stops

---

## 📅 Общий таймлайн

```
Неделя 1-2:  Этапы 0-1 (инфраструктура + сбор данных)
Неделя 3:    Этапы 2-3 (core grid logic + бэктестинг)
Неделя 4:    Этапы 4-5 (классификатор + exchange integration)
Неделя 5:    Этапы 6-7 (Risk + Claude)
Неделя 6:    Этапы 8 (Telegram)
Неделя 7-8:  Этап 9 — Testnet прогон 2 недели
Неделя 9:    Этап 10 (Деплой + реальные деньги, минимум)

Итого: ~2 месяца до первого реального запуска
```

---

## CLAUDE.md — для Claude Code

Создай этот файл в корне проекта:

```markdown
# Crypto Grid Bot — Claude Code Context

## Проект
Автоматический grid trading бот с ML классификатором рынка
и Claude API как стратегическим советником.

## Стек
- Node.js 20+ / NestJS
- PostgreSQL 16 / Prisma
- ccxt (биржа)
- technicalindicators (индикаторы)
- @anthropic-ai/sdk (Claude советник)
- telegraf (Telegram)
- pm2 + VPS (деплой)

## Правила разработки
- TypeScript strict mode везде
- Все секреты только в .env, никогда в коде
- Логировать каждое решение бота в таблицу decision_log
- Hard stops реализованы в коде, не обсуждаются
- Каждый модуль — отдельный NestJS module
- Обработка ошибок и retry на каждом внешнем вызове

## Текущий этап
Этап 0 — инициализация проекта

## Структура модулей
src/modules/exchange, collector, grid, ml, claude, risk, telegram, performance
```

---

> **Главное правило:** Никогда не вкладывать больше, чем готов потерять полностью.
> Grid-бот — инструмент, а не гарантия дохода.