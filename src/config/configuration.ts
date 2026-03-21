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
  },

  claude: {
    apiKey: process.env['CLAUDE_API_KEY'] ?? '',
  },

  telegram: {
    botToken: process.env['TELEGRAM_BOT_TOKEN'] ?? '',
    chatId: process.env['TELEGRAM_CHAT_ID'] ?? '',
  },
});
