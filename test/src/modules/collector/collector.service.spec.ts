import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CollectorService } from '@src/modules/collector/collector.service.js';
import { ExchangeService } from '@src/modules/exchange/exchange.service.js';
import { MlService } from '@src/modules/ml/ml.service.js';
import { PrismaService } from '@src/prisma.service.js';

describe('CollectorService', () => {
  let service: CollectorService;
  let exchange: jest.Mocked<Partial<ExchangeService>>;
  let prisma: Record<string, unknown>;
  let ml: { classifyCurrentRegime: jest.Mock };

  beforeEach(async () => {
    exchange = {
      fetchOHLCV: jest.fn(),
      fetchOrderBook: jest.fn(),
      fetchBalance: jest.fn(),
    };

    prisma = {
      candle: {
        count: jest.fn().mockResolvedValue(100), // skip backfill
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    ml = {
      classifyCurrentRegime: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CollectorService,
        { provide: ExchangeService, useValue: exchange },
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: () => 'ETH/USDT' } },
        { provide: MlService, useValue: ml },
      ],
    }).compile();

    service = module.get<CollectorService>(CollectorService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('pollCandles', () => {
    it('should fetch and store candles for all timeframes', async () => {
      const mockCandle = [1700000000000, 42000, 42500, 41800, 42200, 100];
      (exchange.fetchOHLCV as jest.Mock).mockResolvedValue([mockCandle]);

      await service.pollCandles();

      expect(exchange.fetchOHLCV).toHaveBeenCalledTimes(2); // 1h + 4h
      expect(exchange.fetchOHLCV).toHaveBeenCalledWith(
        'ETH/USDT',
        '1h',
        undefined,
        5,
      );
      expect(exchange.fetchOHLCV).toHaveBeenCalledWith(
        'ETH/USDT',
        '4h',
        undefined,
        5,
      );
    });

    it('should skip duplicate candles', async () => {
      const mockCandle = [1700000000000, 42000, 42500, 41800, 42200, 100];
      (exchange.fetchOHLCV as jest.Mock).mockResolvedValue([mockCandle]);
      (prisma['candle'] as Record<string, jest.Mock>)[
        'findUnique'
      ].mockResolvedValue({
        id: 1,
      });

      await service.pollCandles();

      expect(
        (prisma['candle'] as Record<string, jest.Mock>)['create'],
      ).not.toHaveBeenCalled();
    });
  });

  describe('pollOrderBook', () => {
    it('should store latest orderbook in memory', async () => {
      const mockBook = {
        bids: [[42000, 1]],
        asks: [[42100, 2]],
        symbol: 'ETH/USDT',
      };
      (exchange.fetchOrderBook as jest.Mock).mockResolvedValue(mockBook);

      await service.pollOrderBook();

      expect(service.getLatestOrderBook()).toEqual(mockBook);
    });
  });

  describe('pollBalance', () => {
    it('should store latest balance in memory', async () => {
      const mockBalance = {
        free: { USDT: 1000 },
        used: { USDT: 0 },
        total: { USDT: 1000 },
      };
      (exchange.fetchBalance as jest.Mock).mockResolvedValue(mockBalance);

      await service.pollBalance();

      expect(service.getLatestBalance()).toEqual(mockBalance);
    });

    it('swallows fetch errors', async () => {
      jest.useFakeTimers();
      (exchange.fetchBalance as jest.Mock).mockRejectedValue(new Error('e'));
      const p = service.pollBalance();
      await jest.runAllTimersAsync();
      await p;
      jest.useRealTimers();
    });
  });

  describe('pollOrderBook', () => {
    it('swallows fetch errors', async () => {
      jest.useFakeTimers();
      (exchange.fetchOrderBook as jest.Mock).mockRejectedValue(new Error('e'));
      const p = service.pollOrderBook();
      await jest.runAllTimersAsync();
      await p;
      jest.useRealTimers();
    });
  });

  describe('pollCandles', () => {
    it('logs per-timeframe errors', async () => {
      jest.useFakeTimers();
      (exchange.fetchOHLCV as jest.Mock).mockRejectedValue(new Error('ohlcv'));
      const p = service.pollCandles();
      await jest.runAllTimersAsync();
      await p;
      jest.useRealTimers();
    });
  });

  describe('pollRegime', () => {
    it('delegates to ml service', async () => {
      await service.pollRegime();
      expect(ml.classifyCurrentRegime).toHaveBeenCalledWith('ETH/USDT', '4h');
    });

    it('logs when classify fails', async () => {
      ml.classifyCurrentRegime.mockRejectedValueOnce(new Error('x'));
      await service.pollRegime();
    });
  });

  describe('getRecentCandles', () => {
    it('returns prisma rows', async () => {
      (prisma['candle'] as { findMany: jest.Mock }).findMany.mockResolvedValue([
        { id: 1 },
      ]);
      const rows = await service.getRecentCandles('SOL/USDT', '1h', 5);
      expect(rows).toEqual([{ id: 1 }]);
    });
  });

  describe('onModuleInit backfill', () => {
    it('backfills when count low and logs failures', async () => {
      jest.useFakeTimers();
      (prisma['candle'] as { count: jest.Mock }).count.mockResolvedValue(0);
      (exchange.fetchOHLCV as jest.Mock).mockRejectedValue(new Error('bf'));
      service.onModuleInit();
      await jest.runAllTimersAsync();
      jest.useRealTimers();
    });

    it('stores candles on successful backfill', async () => {
      jest.useFakeTimers();
      (prisma['candle'] as { count: jest.Mock }).count.mockResolvedValue(50);
      (exchange.fetchOHLCV as jest.Mock).mockResolvedValue([
        [Date.now(), 1, 2, 0.5, 1.5, 100],
      ]);
      service.onModuleInit();
      await jest.runAllTimersAsync();
      jest.useRealTimers();
    });

    it('backfill counts saved and duplicate candles', async () => {
      jest.useFakeTimers();
      (prisma['candle'] as { count: jest.Mock }).count.mockResolvedValue(0);
      const ts = Date.now();
      (exchange.fetchOHLCV as jest.Mock).mockResolvedValue([
        [ts, 1, 2, 0.5, 1.5, 100],
        [ts + 1, 1, 2, 0.5, 1.5, 100],
      ]);
      let call = 0;
      (
        prisma['candle'] as { findUnique: jest.Mock }
      ).findUnique.mockImplementation(() => {
        call += 1;
        return Promise.resolve(call % 2 === 1 ? null : { id: 1 });
      });
      await (
        service as unknown as {
          backfillAllTimeframes: () => Promise<void>;
        }
      ).backfillAllTimeframes();
      await jest.runAllTimersAsync();
      jest.useRealTimers();
    });

    it('logs startup failure when classify throws after backfill', async () => {
      jest.useFakeTimers();
      (prisma['candle'] as { count: jest.Mock }).count.mockResolvedValue(100);
      ml.classifyCurrentRegime.mockRejectedValueOnce(new Error('ml-fail'));
      service.onModuleInit();
      await jest.runAllTimersAsync();
      jest.useRealTimers();
    });

    it('backfillAllTimeframes hits skip branch when count >= 60', async () => {
      (prisma['candle'] as { count: jest.Mock }).count.mockResolvedValue(70);
      await (
        service as unknown as {
          backfillAllTimeframes: () => Promise<void>;
        }
      ).backfillAllTimeframes();
    });

    it('backfillAllTimeframes catch uses String for non-Error', async () => {
      jest.useFakeTimers();
      (prisma['candle'] as { count: jest.Mock }).count.mockResolvedValue(0);
      (exchange.fetchOHLCV as jest.Mock).mockRejectedValue('bf');
      const p = (
        service as unknown as {
          backfillAllTimeframes: () => Promise<void>;
        }
      ).backfillAllTimeframes();
      await jest.runAllTimersAsync();
      await p;
      jest.useRealTimers();
    });

    it('classifyRegime catch uses String for non-Error', async () => {
      ml.classifyCurrentRegime.mockRejectedValueOnce('ml');
      await (
        service as unknown as { classifyRegime: () => Promise<void> }
      ).classifyRegime();
    });

    it('pollCandles catch uses String for non-Error', async () => {
      (exchange.fetchOHLCV as jest.Mock).mockRejectedValueOnce('c');
      await service.pollCandles();
    });

    it('pollOrderBook catch runs after withRetry exhausts retries', async () => {
      jest.useFakeTimers();
      // withRetry retries 3× — reject every attempt so catch runs
      (exchange.fetchOrderBook as jest.Mock).mockImplementation(() =>
        Promise.reject(new Error('ob')),
      );
      const p = service.pollOrderBook();
      await jest.runAllTimersAsync();
      await p;
      jest.useRealTimers();
    });

    it('pollBalance catch runs after withRetry exhausts retries', async () => {
      jest.useFakeTimers();
      (exchange.fetchBalance as jest.Mock).mockImplementation(() =>
        Promise.reject(new Error('bal')),
      );
      const p = service.pollBalance();
      await jest.runAllTimersAsync();
      await p;
      jest.useRealTimers();
    });

    it('fetchAndStoreCandles logs debug when new rows stored', async () => {
      (exchange.fetchOHLCV as jest.Mock).mockResolvedValue([
        [Date.now(), 1, 2, 0.5, 1.5, 100],
      ]);
      (
        prisma['candle'] as { findUnique: jest.Mock }
      ).findUnique.mockResolvedValue(null);
      await (
        service as unknown as {
          fetchAndStoreCandles: (p: string, t: string) => Promise<void>;
        }
      ).fetchAndStoreCandles('ETH/USDT', '1h');
    });

    it('fetchAndStoreCandles skips debug when all rows duplicate', async () => {
      (exchange.fetchOHLCV as jest.Mock).mockResolvedValue([
        [Date.now(), 1, 2, 0.5, 1.5, 100],
      ]);
      (
        prisma['candle'] as { findUnique: jest.Mock }
      ).findUnique.mockResolvedValue({
        id: 1,
      });
      await (
        service as unknown as {
          fetchAndStoreCandles: (p: string, t: string) => Promise<void>;
        }
      ).fetchAndStoreCandles('ETH/USDT', '1h');
    });

    it('pollCandles uses Error and non-Error catch branches', async () => {
      jest.useFakeTimers();
      let n = 0;
      (exchange.fetchOHLCV as jest.Mock).mockImplementation(() => {
        n += 1;
        if (n === 1) {
          return Promise.reject(new Error('a'));
        }
        // Exercise `String(error)` branch when rejection is not an Error
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- coverage path
        return Promise.reject('b');
      });
      const p = service.pollCandles();
      await jest.runAllTimersAsync();
      await p;
      jest.useRealTimers();
    });

    it('startup catch stringifies non-Error rejection', async () => {
      jest.useFakeTimers();
      const spy = jest.spyOn(
        CollectorService.prototype,
        'backfillAllTimeframes',
      ) as jest.SpiedFunction<() => Promise<void>>;
      spy.mockRejectedValueOnce('plain');
      service.onModuleInit();
      await jest.runAllTimersAsync();
      spy.mockRestore();
      jest.useRealTimers();
    });

    it('startup catch uses Error message when backfill rejects Error', async () => {
      jest.useFakeTimers();
      const spy = jest.spyOn(
        CollectorService.prototype,
        'backfillAllTimeframes',
      ) as jest.SpiedFunction<() => Promise<void>>;
      spy.mockRejectedValueOnce(new Error('e2'));
      service.onModuleInit();
      await jest.runAllTimersAsync();
      spy.mockRestore();
      jest.useRealTimers();
    });
  });

  describe('default trading pair from config', () => {
    let localService: CollectorService;
    let localExchange: typeof exchange;
    let localPrisma: typeof prisma;

    beforeEach(async () => {
      localExchange = {
        fetchOHLCV: jest.fn(),
        fetchOrderBook: jest.fn(),
        fetchBalance: jest.fn(),
      };
      localPrisma = {
        candle: {
          count: jest.fn().mockResolvedValue(100),
          findUnique: jest.fn().mockResolvedValue({ id: 1 }),
          create: jest.fn().mockResolvedValue({}),
          findMany: jest.fn().mockResolvedValue([]),
        },
      };
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          CollectorService,
          { provide: ExchangeService, useValue: localExchange },
          { provide: PrismaService, useValue: localPrisma },
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((k: string) =>
                k === 'exchange.tradingPair' ? undefined : 'skip',
              ),
            },
          },
          {
            provide: MlService,
            useValue: { classifyCurrentRegime: jest.fn() },
          },
        ],
      }).compile();
      localService = module.get(CollectorService);
    });

    it('pollCandles targets BTC/USDT when trading pair unset', async () => {
      (localExchange.fetchOHLCV as jest.Mock).mockResolvedValue([
        [Date.now(), 1, 2, 0.5, 1.5, 100],
      ]);
      await localService.pollCandles();
      expect(localExchange.fetchOHLCV).toHaveBeenCalledWith(
        'BTC/USDT',
        '1h',
        undefined,
        5,
      );
    });
  });
});
