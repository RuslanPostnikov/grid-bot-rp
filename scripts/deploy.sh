#!/bin/bash
set -e

echo "=== Grid Bot Deploy ==="

# 1. Pull latest code
echo "→ Pulling latest code..."
git pull origin main

# 2. Install dependencies
echo "→ Installing dependencies..."
yarn install --frozen-lockfile

# 3. Generate Prisma client
echo "→ Generating Prisma client..."
npx prisma generate

# 4. Run migrations
echo "→ Running migrations..."
npx prisma migrate deploy

# 5. Build
echo "→ Building..."
npm run build

# 6. Create logs directory
mkdir -p logs

# 7. Restart PM2
echo "→ Restarting PM2..."
if pm2 describe grid-bot > /dev/null 2>&1; then
  pm2 restart grid-bot
else
  pm2 start ecosystem.config.cjs
fi

pm2 save

echo "=== Deploy complete ==="
pm2 status grid-bot
