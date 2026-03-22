import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { GridService } from './grid.service.js';
import { ExchangeService } from '../exchange/exchange.service.js';
import { PrismaService } from '../../prisma.service.js';

describe('GridService', () => {
  let service: GridService;
  let exchange: Record<string, jest.Mock>;
  let prisma: Record<string, unknown>;

  beforeEach(async () => {
    let orderIdCounter = 0;

    exchange = {
      createOrder: jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve({ id: `order-${++orderIdCounter}`, status: 'open' }),
        ),
      cancelOrder: jest
        .fn()
        .mockResolvedValue({ id: '1', status: 'cancelled' }),
      fetchOpenOrders: jest.fn().mockResolvedValue([]),
      getExchange: jest.fn().mockReturnValue({
        fetchOrder: jest.fn().mockResolvedValue({
          id: '1',
          status: 'closed',
          filled: 0.01,
        }),
      }),
    };

    prisma = {
      gridState: {
        create: jest.fn().mockResolvedValue({ id: BigInt(1) }),
        update: jest.fn().mockResolvedValue({}),
      },
      trade: {
        create: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({}),
      },
      decisionLog: {
        create: jest.fn().mockResolvedValue({}),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GridService,
        { provide: ExchangeService, useValue: exchange },
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    service = module.get<GridService>(GridService);
  });

  describe('setupGrid', () => {
    it('should create grid and place orders on exchange', async () => {
      await service.setupGrid('BTC/USDT', 60000, 1500, 10000);

      expect(service.isActive()).toBe(true);
      expect(service.getGrid()).not.toBeNull();
      expect(exchange.createOrder).toHaveBeenCalled();
      expect(
        (prisma['gridState'] as Record<string, jest.Mock>)['create'],
      ).toHaveBeenCalled();
    });

    it('should not setup if grid already active', async () => {
      await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
      const callCount = exchange.createOrder.mock.calls.length;

      await service.setupGrid('BTC/USDT', 60000, 1500, 10000);

      // Should not place more orders
      expect(exchange.createOrder.mock.calls.length).toBe(callCount);
    });

    it('should set correct grid bounds', async () => {
      await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
      const grid = service.getGrid()!;

      expect(grid.lowerBound).toBeCloseTo(60000 - 1500 * 3, 0);
      expect(grid.upperBound).toBeCloseTo(60000 + 1500 * 3, 0);
      expect(grid.pair).toBe('BTC/USDT');
    });
  });

  describe('cancelGrid', () => {
    it('should cancel all placed orders', async () => {
      await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
      await service.cancelGrid();

      expect(service.isActive()).toBe(false);
      expect(exchange.cancelOrder).toHaveBeenCalled();
    });

    it('should update grid state in DB', async () => {
      await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
      await service.cancelGrid();

      expect(
        (prisma['gridState'] as Record<string, jest.Mock>)['update'],
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ active: false }),
        }),
      );
    });
  });

  describe('isPriceInRange', () => {
    it('should return true for price inside grid', async () => {
      await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
      expect(service.isPriceInRange(60000)).toBe(true);
    });

    it('should return false for price outside grid', async () => {
      await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
      expect(service.isPriceInRange(70000)).toBe(false);
    });

    it('should return false when no grid', () => {
      expect(service.isPriceInRange(60000)).toBe(false);
    });
  });

  describe('pollOrderStatuses', () => {
    it('should detect filled orders and create counter-orders', async () => {
      await service.setupGrid('BTC/USDT', 60000, 1500, 10000);

      // Mock: exchange returns no open orders (all filled)
      exchange.fetchOpenOrders.mockResolvedValue([]);

      // Mock fetchOrder to return closed
      exchange.getExchange.mockReturnValue({
        fetchOrder: jest.fn().mockResolvedValue({
          id: 'order-1',
          status: 'closed',
          filled: 0.01,
        }),
      });

      const ordersBefore = exchange.createOrder.mock.calls.length;
      await service.pollOrderStatuses();

      // Should have placed counter orders
      expect(exchange.createOrder.mock.calls.length).toBeGreaterThan(
        ordersBefore,
      );
    });

    it('should re-place orders cancelled by exchange', async () => {
      await service.setupGrid('BTC/USDT', 60000, 1500, 10000);

      exchange.fetchOpenOrders.mockResolvedValue([]);
      exchange.getExchange.mockReturnValue({
        fetchOrder: jest.fn().mockResolvedValue({
          id: 'order-1',
          status: 'canceled',
          filled: 0,
        }),
      });

      const ordersBefore = exchange.createOrder.mock.calls.length;
      await service.pollOrderStatuses();

      // Should re-place cancelled orders
      expect(exchange.createOrder.mock.calls.length).toBeGreaterThan(
        ordersBefore,
      );
    });

    it('should not process when grid is inactive', async () => {
      await service.pollOrderStatuses();
      expect(exchange.fetchOpenOrders).not.toHaveBeenCalled();
    });
  });

  describe('reconcileWithExchange', () => {
    it('should cancel orphan orders on exchange', async () => {
      await service.setupGrid('BTC/USDT', 60000, 1500, 10000);

      // Exchange has an order our grid doesn't know about
      exchange.fetchOpenOrders.mockResolvedValue([
        { id: 'orphan-1', side: 'buy', price: 55000 },
      ]);

      await service.reconcileWithExchange();

      expect(exchange.cancelOrder).toHaveBeenCalledWith('orphan-1', 'BTC/USDT');
    });

    it('should skip when no grid active', async () => {
      await service.reconcileWithExchange();
      expect(exchange.fetchOpenOrders).not.toHaveBeenCalled();
    });
  });
});
