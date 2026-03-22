export default () => ({
  port: parseInt(process.env['PORT'] ?? '3000', 10),
  nodeEnv: process.env['NODE_ENV'] ?? 'development',

  database: {
    url: process.env['DATABASE_URL'],
  },

  exchange: {
    id: process.env['EXCHANGE_ID'] ?? 'binance',
    apiKey: process.env['EXCHANGE_API_KEY'] ?? '',
    apiSecret: process.env['EXCHANGE_API_SECRET'] ?? '',
    testnet: process.env['EXCHANGE_TESTNET'] === 'true',
    tradingPair: process.env['TRADING_PAIR'] ?? 'BTC/USDT',
  },

  claude: {
    apiKey: process.env['CLAUDE_API_KEY'] ?? '',
  },

  risk: {
    activeCapitalPct: parseInt(process.env['RISK_ACTIVE_CAPITAL_PCT'] ?? '60', 10),
    reserveCapitalPct: parseInt(process.env['RISK_RESERVE_CAPITAL_PCT'] ?? '30', 10),
    minBufferPct: parseInt(process.env['RISK_MIN_BUFFER_PCT'] ?? '10', 10),
  },

  telegram: {
    botToken: process.env['TELEGRAM_BOT_TOKEN'] ?? '',
    chatId: process.env['TELEGRAM_CHAT_ID'] ?? '',
    allowedUsers: (process.env['TELEGRAM_ALLOWED_USERS'] ?? '').split(',').filter(Boolean),
  },
});
