const mockSetSandboxMode = jest.fn();
const MockExchange = jest.fn().mockImplementation(() => ({
  setSandboxMode: mockSetSandboxMode,
  fetchOHLCV: jest.fn(),
  fetchTicker: jest.fn(),
  fetchBalance: jest.fn(),
  fetchOpenOrders: jest.fn(),
  createOrder: jest.fn(),
  cancelOrder: jest.fn(),
  fetchOrderBook: jest.fn(),
  fetchTradingFee: jest
    .fn()
    .mockResolvedValue({ maker: 0.0005, taker: 0.0005 }),
}));

jest.mock('ccxt', () => ({
  __esModule: true,
  default: {
    binance: MockExchange,
    nonexistent: undefined,
  },
}));

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ExchangeService } from '@src/modules/exchange/exchange.service.js';

type MockCcxt = {
  fetchOHLCV: jest.Mock;
  fetchTicker: jest.Mock;
  fetchBalance: jest.Mock;
  fetchOpenOrders: jest.Mock;
  createOrder: jest.Mock;
  cancelOrder: jest.Mock;
  fetchOrderBook: jest.Mock;
  fetchTradingFee: jest.Mock;
};

describe('ExchangeService', () => {
  let service: ExchangeService;

  it('constructs with injected config', () => {
    const cfg = {
      get: jest.fn(),
    } as unknown as ConfigService;
    const s = new ExchangeService(cfg);
    expect(s).toBeDefined();
  });

  async function createModule(testnet: boolean) {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExchangeService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, def?: unknown) => {
              const m: Record<string, unknown> = {
                'exchange.id': 'binance',
                'exchange.apiKey': 'k',
                'exchange.apiSecret': 's',
                'exchange.testnet': testnet,
              };
              return m[key] ?? def;
            }),
          },
        },
      ],
    }).compile();
    return module.get(ExchangeService);
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('onModuleInit uses default exchange id from config.get second arg', async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExchangeService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, def?: unknown) => {
              const m: Record<string, unknown> = {
                'exchange.apiKey': 'k',
                'exchange.apiSecret': 's',
                'exchange.testnet': false,
              };
              return m[key] ?? def;
            }),
          },
        },
      ],
    }).compile();
    const s = module.get(ExchangeService);
    s.onModuleInit();
    expect(MockExchange).toHaveBeenCalled();
  });

  it('onModuleInit builds exchange and sets sandbox when testnet', async () => {
    service = await createModule(true);
    service.onModuleInit();
    expect(MockExchange).toHaveBeenCalled();
    expect(mockSetSandboxMode).toHaveBeenCalledWith(true);
    expect(service.getExchange()).toBeDefined();
  });

  it('onModuleInit skips sandbox when not testnet', async () => {
    service = await createModule(false);
    service.onModuleInit();
    expect(mockSetSandboxMode).not.toHaveBeenCalled();
  });

  it('onModuleInit throws when exchange id missing from ccxt', async () => {
    const module = await Test.createTestingModule({
      providers: [
        ExchangeService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, def?: unknown) => {
              if (key === 'exchange.id') return 'nonexistent';
              return def;
            }),
          },
        },
      ],
    }).compile();
    const svc = module.get(ExchangeService);
    expect(() => svc.onModuleInit()).toThrow('not found in ccxt');
  });

  it('delegates API calls to exchange instance', async () => {
    service = await createModule(false);
    service.onModuleInit();
    const ex = service.getExchange() as unknown as MockCcxt;
    ex.fetchOHLCV.mockResolvedValue([]);
    ex.fetchTicker.mockResolvedValue({ last: 1 });
    ex.fetchBalance.mockResolvedValue({});
    ex.fetchOpenOrders.mockResolvedValue([]);
    ex.createOrder.mockResolvedValue({ id: '1' });
    ex.cancelOrder.mockResolvedValue({});
    ex.fetchOrderBook.mockResolvedValue({ bids: [], asks: [] });
    ex.fetchTradingFee.mockResolvedValue({ maker: 0.1, taker: 0.2 });

    await service.fetchOHLCV('BTC/USDT', '1h');
    await service.fetchTicker('BTC/USDT');
    await service.fetchBalance();
    await service.fetchOpenOrders();
    await service.createOrder('BTC/USDT', 'limit', 'buy', 1, 2);
    await service.cancelOrder('1');
    await service.fetchOrderBook('BTC/USDT');
    const fee = await service.fetchTradingFee('BTC/USDT');
    expect(fee).toEqual({ maker: 0.1, taker: 0.2 });
  });

  it('fetchTradingFee uses defaults when maker/taker missing', async () => {
    service = await createModule(false);
    service.onModuleInit();
    const ex = service.getExchange() as unknown as MockCcxt;
    ex.fetchTradingFee.mockResolvedValue({});
    const fee = await service.fetchTradingFee('BTC/USDT');
    expect(fee).toEqual({ maker: 0.001, taker: 0.001 });
  });
});
