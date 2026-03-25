#!/bin/bash
set -e

echo "=== VPS Initial Setup for Grid Bot ==="

# 1. System updates
echo "→ Updating system..."
sudo apt update && sudo apt upgrade -y

# 2. Install Node.js 20
echo "→ Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 3. Install PM2 and Yarn
echo "→ Installing PM2 and Yarn..."
sudo npm install -g pm2 yarn

# 4. Install PostgreSQL 16
echo "→ Installing PostgreSQL 16..."
sudo apt install -y postgresql-16 postgresql-client-16

# 5. Setup PostgreSQL
echo "→ Setting up PostgreSQL..."
sudo -u postgres psql -c "CREATE USER gridbot WITH PASSWORD 'CHANGE_ME_TO_STRONG_PASSWORD';" 2>/dev/null || true
sudo -u postgres psql -c "CREATE DATABASE gridbot OWNER gridbot;" 2>/dev/null || true

# 6. Firewall — only SSH, block everything else
echo "→ Configuring firewall..."
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw --force enable

# 7. PM2 startup on boot
echo "→ Setting up PM2 startup..."
pm2 startup systemd -u $USER --hp $HOME

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Clone the repo: git clone <your-repo-url>"
echo "  2. Create .env file with production values"
echo "  3. Update DB password in .env (match what you set above)"
echo "  4. Set IP whitelist on Binance for this server's IP"
echo "  5. Run: bash scripts/deploy.sh"
