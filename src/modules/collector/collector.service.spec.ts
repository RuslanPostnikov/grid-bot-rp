import { Test, TestingModule } from '@nestjs/testing';
import { CollectorService } from './collector.service.js';
import { ExchangeService } from '../exchange/exchange.service.js';
import { PrismaService } from '../../prisma.service.js';

describe('CollectorService', () => {
  let service: CollectorService;
  let exchange: jest.Mocked<Partial<ExchangeService>>;
  let prisma: Record<string, unknown>;

  beforeEach(async () => {
    exchange = {
      fetchOHLCV: jest.fn(),
      fetchOrderBook: jest.fn(),
      fetchBalance: jest.fn(),
    };

    prisma = {
      candle: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CollectorService,
        { provide: ExchangeService, useValue: exchange },
        { provide: PrismaService, useValue: prisma },
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
        'BTC/USDT',
        '1h',
        undefined,
        5,
      );
      expect(exchange.fetchOHLCV).toHaveBeenCalledWith(
        'BTC/USDT',
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
        symbol: 'BTC/USDT',
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
  });
});
