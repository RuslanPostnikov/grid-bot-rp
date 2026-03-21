# Crypto Grid Bot — Claude Code Context

## Проект
Автоматический grid trading бот с rule-based классификатором рынка
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