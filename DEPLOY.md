# Deploy Guide

## Первый деплой (уже сделан)

1. Настроить VPS: `bash scripts/vps-setup.sh`
2. Клонировать репо: `git clone https://github.com/RuslanPostnikov/grid-bot-rp.git`
3. Создать `.env` (см. ниже)
4. Запустить: `bash scripts/deploy.sh`

---

## Редеплой после изменений в коде

```bash
# 1. На своём Mac — запушить код
git add .
git commit -m "your message"
git push origin main

# 2. На сервере — обновить и перезапустить
ssh root@144.91.123.231
cd /root/grid-bot-rp
bash scripts/deploy.sh
```

`deploy.sh` сам делает: `git pull` → `yarn install --frozen-lockfile` → `prisma generate` → `prisma migrate deploy` → `npm run build` → `pm2 restart`

---

## Изменить переменную окружения без редеплоя кода

```bash
ssh root@144.91.123.231
nano /root/grid-bot-rp/.env
# изменить нужное значение, сохранить (Ctrl+X → Y → Enter)
pm2 restart grid-bot
```

---

## Полезные PM2 команды

```bash
pm2 status              # статус бота
pm2 logs grid-bot       # логи в реальном времени
pm2 logs grid-bot --lines 100  # последние 100 строк
pm2 restart grid-bot    # перезапустить
pm2 stop grid-bot       # остановить
pm2 start grid-bot      # запустить
pm2 monit               # CPU/RAM мониторинг
```

---

## .env на проде

```env
# App
PORT=3000
NODE_ENV=production

# Database
DATABASE_URL="postgresql://gridbot:PASSWORD@localhost:5432/gridbot?schema=public"

# Exchange
EXCHANGE_ID=binance
EXCHANGE_API_KEY=your_real_key
EXCHANGE_API_SECRET=your_real_secret
EXCHANGE_TESTNET=false
TRADING_PAIR=ETH/USDT

# Claude API
CLAUDE_API_KEY=your_claude_key

# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
TELEGRAM_ALLOWED_USERS=RuslanPostnikov
```

---

## Мониторинг

- Telegram `/status` — текущее состояние сетки и баланс
- Telegram `/pnl` — прибыль за 24ч и неделю
- Ежедневный отчёт автоматически в 00:00
- Heartbeat каждые 15 мин (лог на сервере)
