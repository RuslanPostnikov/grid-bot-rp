import configuration from '@src/config/configuration.js';

describe('configuration', () => {
  const envKeys = [
    'PORT',
    'NODE_ENV',
    'DATABASE_URL',
    'EXCHANGE_ID',
    'EXCHANGE_API_KEY',
    'EXCHANGE_API_SECRET',
    'EXCHANGE_TESTNET',
    'TRADING_PAIR',
    'CLAUDE_API_KEY',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
    'TELEGRAM_ALLOWED_USERS',
    'RISK_ACTIVE_CAPITAL_PCT',
    'RISK_RESERVE_CAPITAL_PCT',
    'RISK_MIN_BUFFER_PCT',
    'RISK_MAX_PRICE_DEVIATION_PCT',
  ] as const;

  const snapshot: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const k of envKeys) snapshot[k] = process.env[k];
  });

  afterAll(() => {
    for (const k of envKeys) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  });

  beforeEach(() => {
    for (const k of envKeys) delete process.env[k];
  });

  it('applies defaults when env is empty', () => {
    const c = configuration();
    expect(c.port).toBe(3000);
    expect(c.nodeEnv).toBe('development');
    expect(c.database.url).toBeUndefined();
    expect(c.exchange.id).toBe('binance');
    expect(c.exchange.apiKey).toBe('');
    expect(c.exchange.testnet).toBe(false);
    expect(c.exchange.tradingPair).toBe('BTC/USDT');
    expect(c.claude.apiKey).toBe('');
    expect(c.risk.activeCapitalPct).toBe(60);
    expect(c.risk.reserveCapitalPct).toBe(30);
    expect(c.risk.minBufferPct).toBe(10);
    expect(c.risk.maxPriceDeviationPct).toBe(5);
    expect(c.telegram.botToken).toBe('');
    expect(c.telegram.chatId).toBe('');
    expect(c.telegram.allowedUsers).toEqual([]);
  });

  it('parses numeric port and risk ints', () => {
    process.env.PORT = '8080';
    process.env.RISK_ACTIVE_CAPITAL_PCT = '90';
    process.env.RISK_RESERVE_CAPITAL_PCT = '5';
    process.env.RISK_MIN_BUFFER_PCT = '5';
    process.env.RISK_MAX_PRICE_DEVIATION_PCT = '7';
    const c = configuration();
    expect(c.port).toBe(8080);
    expect(c.risk.activeCapitalPct).toBe(90);
    expect(c.risk.reserveCapitalPct).toBe(5);
    expect(c.risk.minBufferPct).toBe(5);
    expect(c.risk.maxPriceDeviationPct).toBe(7);
  });

  it('sets exchange.testnet when EXCHANGE_TESTNET is true', () => {
    process.env.EXCHANGE_TESTNET = 'true';
    expect(configuration().exchange.testnet).toBe(true);
  });

  it('splits TELEGRAM_ALLOWED_USERS and filters empty', () => {
    process.env.TELEGRAM_ALLOWED_USERS = 'alice,,bob,';
    expect(configuration().telegram.allowedUsers).toEqual(['alice', 'bob']);
  });
});
