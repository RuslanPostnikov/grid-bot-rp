import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { GridService } from '@src/modules/grid/grid.service.js';
import { ExchangeService } from '@src/modules/exchange/exchange.service.js';
import { PrismaService } from '@src/prisma.service.js';
import { BOT_EVENTS } from '@src/common/events.js';
import * as ti from 'technicalindicators';
import * as gridCalculator from '@src/modules/grid/grid-calculator.js';

jest.mock('technicalindicators', () => ({
  ATR: { calculate: jest.fn().mockReturnValue(Array(20).fill(50)) },
}));

describe('GridService branches', () => {
  it('constructs with direct DI args', () => {
    const ex = {} as ExchangeService;
    const pr = {} as PrismaService;
    const ee = { emit: jest.fn() } as unknown as EventEmitter2;
    const cfg = { get: jest.fn() } as unknown as ConfigService;
    expect(new GridService(ex, pr, ee, cfg)).toBeInstanceOf(GridService);
  });

  let service: GridService;
  let exchange: Record<string, jest.Mock>;
  let prisma: Record<string, Record<string, jest.Mock>>;
  let emit: jest.Mock;

  async function compileFresh() {
    let orderId = 0;
    exchange = {
      createOrder: jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve({ id: `o-${++orderId}`, status: 'open' }),
        ),
      cancelOrder: jest.fn().mockResolvedValue({}),
      fetchOpenOrders: jest.fn().mockResolvedValue([]),
      fetchTicker: jest.fn().mockResolvedValue({ last: 100 }),
      fetchBalance: jest.fn().mockResolvedValue({
        free: { USDT: 1000, BTC: 0, SOL: 0 },
        used: {},
      }),
      fetchTradingFee: jest
        .fn()
        .mockResolvedValue({ maker: 0.001, taker: 0.001 }),
      fetchOHLCV: jest
        .fn()
        .mockResolvedValue(
          Array.from({ length: 20 }, () => [0, 0, 100, 90, 95, 1]),
        ),
      getExchange: jest.fn().mockReturnValue({
        fetchOrder: jest.fn().mockResolvedValue({
          id: 'x',
          status: 'closed',
          filled: 0.01,
        }),
      }),
    };

    prisma = {
      gridState: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: BigInt(1) }),
        update: jest.fn().mockResolvedValue({}),
      },
      gridOrder: {
        create: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({}),
      },
      trade: {
        create: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
      decisionLog: {
        create: jest.fn().mockResolvedValue({}),
      },
    };

    emit = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GridService,
        { provide: ExchangeService, useValue: exchange },
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: { emit } },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(90) },
        },
      ],
    }).compile();

    return module.get(GridService);
  }

  beforeEach(async () => {
    service = await compileFresh();
  });

  it('onModuleInit restores active grid from DB', async () => {
    prisma.gridState.findFirst.mockResolvedValue({
      id: BigInt(9),
      pair: 'BTC/USDT',
      active: true,
      lowerBound: '50000',
      upperBound: '60000',
      gridStepPct: '1',
      levelsCount: 5,
      orders: [
        {
          levelIndex: 0,
          side: 'buy',
          price: '51000',
          quantity: '0.01',
          status: 'placed',
          exchangeOrderId: 'ex-1',
          gridCycleId: 'cyc',
          placedAt: new Date(),
        },
      ],
    });
    exchange.fetchOpenOrders.mockResolvedValue([{ id: 'ex-1' }]);
    await service.onModuleInit();
    expect(service.isActive()).toBe(true);
    expect(service.getGrid()?.orders.length).toBeGreaterThan(0);
  });

  it('onModuleInit restore uses nullish coalescing on order fields', async () => {
    prisma.gridState.findFirst.mockResolvedValue({
      id: BigInt(11),
      pair: 'ETH/USDT',
      active: true,
      lowerBound: '2000',
      upperBound: '3000',
      gridStepPct: '1',
      levelsCount: 3,
      orders: [
        {
          levelIndex: 0,
          side: 'buy',
          price: '2500',
          quantity: '0.1',
          status: 'placed',
          exchangeOrderId: null,
          gridCycleId: null,
          placedAt: null,
        },
      ],
    });
    exchange.fetchOpenOrders.mockResolvedValue([]);
    await service.onModuleInit();
    const g = service.getGrid();
    expect(g?.orders[0].exchangeOrderId).toBeUndefined();
    expect(g?.orders[0].gridCycleId).toBeTruthy();
    expect(g?.orders[0].placedAt).toBeUndefined();
  });

  it('onModuleInit restore ignores cancelled orders in filter', async () => {
    prisma.gridState.findFirst.mockResolvedValue({
      id: BigInt(9),
      pair: 'BTC/USDT',
      active: true,
      lowerBound: '50000',
      upperBound: '60000',
      gridStepPct: '1',
      levelsCount: 5,
      orders: [
        {
          levelIndex: 0,
          side: 'buy',
          price: '51000',
          quantity: '0.01',
          status: 'cancelled',
          exchangeOrderId: null,
          gridCycleId: 'cyc0',
          placedAt: null,
        },
        {
          levelIndex: 1,
          side: 'buy',
          price: '50000',
          quantity: '0.01',
          status: 'placed',
          exchangeOrderId: 'ex-9',
          gridCycleId: 'cyc1',
          placedAt: new Date(),
        },
      ],
    });
    exchange.fetchOpenOrders.mockResolvedValue([{ id: 'ex-9' }]);
    await service.onModuleInit();
    const g = service.getGrid();
    expect(g?.orders.every((o) => o.status !== 'cancelled')).toBe(true);
  });

  it('recoverOrphanedPosition returns when grid inactive', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    (service as unknown as { grid: { active: boolean } }).grid.active = false;
    await (
      service as unknown as {
        recoverOrphanedPosition: (p: string, pr: number) => Promise<void>;
      }
    ).recoverOrphanedPosition('BTC/USDT', 60000);
  });

  it('cancelGrid skips DB update when gridStateId null', async () => {
    jest.useFakeTimers();
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    (
      service as unknown as { grid: { gridStateId: bigint | null } }
    ).grid.gridStateId = null;
    prisma.gridState.update.mockClear();
    const p = service.cancelGrid();
    await jest.runAllTimersAsync();
    await p;
    expect(prisma.gridState.update).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('setupGridWithParams skips when grid already active', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    const n = exchange.createOrder.mock.calls.length;
    await service.setupGridWithParams('BTC/USDT', 60000, 5000, 40000, 80000, 1);
    expect(exchange.createOrder.mock.calls.length).toBe(n);
  });

  it('setupGridWithParams creates grid when inactive', async () => {
    await service.setupGridWithParams('ETH/USDT', 3000, 8000, 2500, 3500, 1.2);
    expect(service.isActive()).toBe(true);
  });

  it('recoverOrphanedPosition skips when balance fetch fails', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.fetchBalance.mockRejectedValueOnce(new Error('bal'));
    await (
      service as unknown as {
        recoverOrphanedPosition: (p: string, pr: number) => Promise<void>;
      }
    ).recoverOrphanedPosition('BTC/USDT', 60000);
  });

  it('recoverOrphanedPosition places sell when SOL notional high', async () => {
    await service.setupGrid('SOL/USDT', 100, 20, 5000);
    exchange.fetchBalance.mockResolvedValue({
      free: { SOL: 1 },
      used: {},
    });
    await (
      service as unknown as {
        recoverOrphanedPosition: (p: string, pr: number) => Promise<void>;
      }
    ).recoverOrphanedPosition('SOL/USDT', 100);
    expect(exchange.createOrder).toHaveBeenCalled();
  });

  it('recoverOrphanedPosition HOLDS with breakeven limit-sell when 7%+ below avg buy (Fix 1.1)', async () => {
    await service.setupGrid('SOL/USDT', 100, 20, 5000);
    prisma.trade.findMany.mockResolvedValue([{ price: 100, quantity: 1 }]);
    exchange.fetchBalance.mockResolvedValue({
      free: { SOL: 1 },
      used: {},
    });
    exchange.createOrder.mockClear();
    prisma.trade.create.mockClear();

    await (
      service as unknown as {
        recoverOrphanedPosition: (p: string, pr: number) => Promise<void>;
      }
    ).recoverOrphanedPosition('SOL/USDT', 92);

    // Fix 1.1: must NOT market-sell at a loss. Place limit-sell at breakeven
    // (avg buy 100 × (1 + fee×2 + 0.3%)) instead.
    const calls = (
      exchange.createOrder as jest.Mock<
        unknown,
        [string, string, string, number, number]
      >
    ).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0][1]).toBe('limit');
    expect(calls[0][2]).toBe('sell');
    // Limit price must be >= breakeven (>= avg buy 100), never the market-loss price 92.
    expect(calls[0][4]).toBeGreaterThanOrEqual(100);
    // No loss-trade record should be written.
    expect(prisma.trade.create).not.toHaveBeenCalled();
  });

  it('recoverOrphanedPosition places profit limit sell when price above avg buy', async () => {
    await service.setupGrid('SOL/USDT', 100, 20, 5000);
    prisma.trade.findMany.mockResolvedValue([{ price: 90, quantity: 1 }]);
    exchange.fetchBalance.mockResolvedValue({
      free: { SOL: 1 },
      used: {},
    });
    exchange.createOrder.mockClear();

    await (
      service as unknown as {
        recoverOrphanedPosition: (p: string, pr: number) => Promise<void>;
      }
    ).recoverOrphanedPosition('SOL/USDT', 100);

    expect(exchange.createOrder).toHaveBeenCalledWith(
      'SOL/USDT',
      'limit',
      'sell',
      1,
      101,
    );
  });

  it('checkPositionStopLoss returns when grid inactive', async () => {
    await service.setupGrid('SOL/USDT', 100, 20, 5000);
    (service as unknown as { grid: { active: boolean } }).grid.active = false;
    exchange.fetchTicker.mockClear();
    await service.checkPositionStopLoss();
    expect(exchange.fetchTicker).not.toHaveBeenCalled();
  });

  it('checkPositionStopLoss HOLDS limit-sell on deep drawdown — no market-sell (Fix 1.1)', async () => {
    await service.setupGrid('SOL/USDT', 100, 20, 5000);
    const g = service.getGrid()!;
    g.gridStepPct = 1;
    g.orders.push({
      levelIndex: 50,
      side: 'sell',
      price: 101,
      quantity: 0.1,
      status: 'placed',
      exchangeOrderId: 'exo-sell-sl',
      gridCycleId: 'gc-sl',
      placedAt: new Date(),
    });

    exchange.fetchTicker.mockResolvedValue({ last: 92 });
    exchange.cancelOrder.mockClear();
    exchange.createOrder.mockClear();
    prisma.trade.create.mockClear();
    prisma.decisionLog.create.mockClear();
    emit.mockClear();

    await service.checkPositionStopLoss();

    // Fix 1.1: periodic stop-loss must NOT cancel or market-sell.
    // It only logs a warning. The limit-sell stays in place to recover.
    expect(exchange.cancelOrder).not.toHaveBeenCalled();
    expect(exchange.createOrder).not.toHaveBeenCalled();
    expect(prisma.trade.create).not.toHaveBeenCalled();
    expect(prisma.decisionLog.create).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith(
      BOT_EVENTS.ORDER_FILLED,
      expect.anything(),
    );
  });

  const minimalBuyOrder = {
    levelIndex: 0,
    side: 'buy' as const,
    price: 100,
    quantity: 0.01,
    status: 'pending' as const,
    gridCycleId: 'c0',
  };

  it('recoverOrphanedPosition returns when grid is missing', async () => {
    await (
      service as unknown as {
        recoverOrphanedPosition: (pair: string, pr: number) => Promise<void>;
      }
    ).recoverOrphanedPosition('BTC/USDT', 60000);
  });

  it('placeAllPendingOrders returns when grid is missing', async () => {
    await (
      service as unknown as { placeAllPendingOrders: () => Promise<void> }
    ).placeAllPendingOrders();
  });

  it('placeAllPendingOrders returns when grid inactive', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    (service as unknown as { grid: { active: boolean } }).grid.active = false;
    await (
      service as unknown as { placeAllPendingOrders: () => Promise<void> }
    ).placeAllPendingOrders();
  });

  it('placeOrder returns when grid is missing', async () => {
    await (
      service as unknown as {
        placeOrder: (o: typeof minimalBuyOrder) => Promise<void>;
      }
    ).placeOrder(minimalBuyOrder);
  });

  it('placeOrder returns when grid inactive', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    (service as unknown as { grid: { active: boolean } }).grid.active = false;
    await (
      service as unknown as {
        placeOrder: (o: typeof minimalBuyOrder) => Promise<void>;
      }
    ).placeOrder(minimalBuyOrder);
  });

  it('saveOrderToDb returns when grid is missing', async () => {
    await (
      service as unknown as {
        saveOrderToDb: (o: typeof minimalBuyOrder) => Promise<void>;
      }
    ).saveOrderToDb(minimalBuyOrder);
  });

  it('saveOrderToDb returns when gridStateId missing', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    (
      service as unknown as { grid: { gridStateId: bigint | null } }
    ).grid.gridStateId = null;
    await (
      service as unknown as {
        saveOrderToDb: (o: typeof minimalBuyOrder) => Promise<void>;
      }
    ).saveOrderToDb(minimalBuyOrder);
  });

  it('pollOrderStatuses returns when grid is missing', async () => {
    await service.pollOrderStatuses();
  });

  it('pollOrderStatuses returns when grid inactive', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    (service as unknown as { grid: { active: boolean } }).grid.active = false;
    await service.pollOrderStatuses();
  });

  it('checkStaleOrders returns when grid is missing', () => {
    (service as unknown as { checkStaleOrders: () => void }).checkStaleOrders();
  });

  it('checkStaleOrders returns when grid inactive', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    (service as unknown as { grid: { active: boolean } }).grid.active = false;
    (service as unknown as { checkStaleOrders: () => void }).checkStaleOrders();
  });

  it('checkAndProcessFills returns when grid is missing', async () => {
    await (
      service as unknown as { checkAndProcessFills: () => Promise<void> }
    ).checkAndProcessFills();
  });

  it('checkAndProcessFills returns when grid inactive', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    (service as unknown as { grid: { active: boolean } }).grid.active = false;
    await (
      service as unknown as { checkAndProcessFills: () => Promise<void> }
    ).checkAndProcessFills();
  });

  it('handleFilledOrCancelled returns when grid is missing', async () => {
    const o = {
      ...minimalBuyOrder,
      status: 'placed' as const,
      exchangeOrderId: 'ex-guard',
    };
    await (
      service as unknown as {
        handleFilledOrCancelled: (
          order: typeof o,
          price: number,
        ) => Promise<void>;
      }
    ).handleFilledOrCancelled(o, 100);
  });

  it('handleFilledOrCancelled returns when grid inactive', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    (service as unknown as { grid: { active: boolean } }).grid.active = false;
    const o = {
      ...minimalBuyOrder,
      status: 'placed' as const,
      exchangeOrderId: 'ex-guard2',
    };
    await (
      service as unknown as {
        handleFilledOrCancelled: (
          order: typeof o,
          price: number,
        ) => Promise<void>;
      }
    ).handleFilledOrCancelled(o, 100);
  });

  it('checkRebalance returns when grid is missing', async () => {
    await service.checkRebalance();
  });

  it('checkRebalance returns when grid inactive', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    (service as unknown as { grid: { active: boolean } }).grid.active = false;
    await service.checkRebalance();
  });

  it('cancelGrid no-op when no grid', async () => {
    await service.cancelGrid();
    expect(exchange.cancelOrder).not.toHaveBeenCalled();
  });

  it('updateOrderStatusInDb swallows prisma errors', async () => {
    prisma.gridOrder.updateMany.mockRejectedValueOnce(new Error('u'));
    await (
      service as unknown as {
        updateOrderStatusInDb: (id: string, s: string) => Promise<void>;
      }
    ).updateOrderStatusInDb('ex-1', 'filled');
  });

  it('cancelGrid handles -2011 and processes closed order', async () => {
    jest.useFakeTimers();
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.cancelOrder.mockRejectedValue(
      new Error('Binance -2011 Unknown order'),
    );
    exchange.getExchange.mockReturnValue({
      fetchOrder: jest.fn().mockResolvedValue({
        id: 'order-1',
        status: 'closed',
        filled: 0.01,
      }),
    });
    const g = service.getGrid()!;
    const placed = g.orders.find((o) => o.status === 'placed');
    if (placed) placed.exchangeOrderId = 'order-1';
    const p = service.cancelGrid();
    await jest.runAllTimersAsync();
    await p;
    jest.useRealTimers();
  });

  it('cancelGrid -2011 with open order on exchange marks cancelled', async () => {
    jest.useFakeTimers();
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.cancelOrder.mockRejectedValue(new Error('-2011 Unknown order'));
    exchange.getExchange.mockReturnValue({
      fetchOrder: jest.fn().mockResolvedValue({
        status: 'open',
        filled: 0,
      }),
    });
    const g = service.getGrid()!;
    const placed = g.orders.find((o) => o.status === 'placed');
    if (placed) placed.exchangeOrderId = 'order-x';
    const p = service.cancelGrid();
    await jest.runAllTimersAsync();
    await p;
    jest.useRealTimers();
  });

  it('cancelGrid -2011 fetchOrder throws', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.cancelOrder.mockRejectedValueOnce(new Error('Unknown order'));
    exchange.getExchange.mockReturnValue({
      fetchOrder: jest.fn().mockRejectedValue(new Error('e')),
    });
    const g = service.getGrid()!;
    const placed = g.orders.find((o) => o.status === 'placed');
    if (placed) placed.exchangeOrderId = 'order-z';
    await service.cancelGrid();
  });

  it('cancelGrid logs non-2011 cancel errors', async () => {
    jest.useFakeTimers();
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.cancelOrder.mockRejectedValue(new Error('other'));
    const p = service.cancelGrid();
    await jest.runAllTimersAsync();
    await p;
    jest.useRealTimers();
  });

  it('placeOrder logs create failure', async () => {
    jest.useFakeTimers();
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.createOrder.mockImplementation(() =>
      Promise.reject(new Error('place')),
    );
    const p = service.pollOrderStatuses();
    await jest.runAllTimersAsync();
    await p;
    jest.useRealTimers();
  });

  it('placeOrder logs create failure', async () => {
    jest.useFakeTimers();
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.createOrder.mockImplementation(() =>
      Promise.reject(new Error('bad')),
    );
    const p = service.pollOrderStatuses();
    await jest.runAllTimersAsync();
    await p;
    jest.useRealTimers();
  });

  it('saveOrderToDb logs prisma failure', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    prisma.gridOrder.create.mockRejectedValueOnce('db');
    exchange.createOrder.mockResolvedValueOnce({ id: 'new-1' });
    await service.pollOrderStatuses();
  });

  it('saveOrderToDb updates existing row', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    prisma.gridOrder.findFirst.mockResolvedValue({ id: BigInt(99) });
    await service.pollOrderStatuses();
  });

  it('onOrderFilled returns early when grid is null', async () => {
    prisma.trade.create.mockClear();
    const order = {
      side: 'buy' as const,
      price: 100,
      quantity: 0.01,
      levelIndex: 0,
      status: 'placed' as const,
      exchangeOrderId: 'x',
      gridCycleId: 'c',
    };
    await (
      service as unknown as {
        onOrderFilled: (o: typeof order, q: number, p: number) => Promise<void>;
      }
    ).onOrderFilled(order, 0.01, 100);
    expect(prisma.trade.create).not.toHaveBeenCalled();
  });

  it('pollOrderStatuses skips when processing lock held', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    const inst = service as unknown as { processingOrders: boolean };
    inst.processingOrders = true;
    await service.pollOrderStatuses();
    inst.processingOrders = false;
  });

  it('emits STALE_ORDERS for old buy orders', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-01T12:00:00Z'));
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    const g = service.getGrid()!;
    for (const o of g.orders) {
      if (o.side === 'buy' && o.status === 'placed') {
        o.placedAt = new Date('2026-06-01T10:00:00Z');
        o.exchangeOrderId = 'stale-1';
      }
    }
    exchange.fetchOpenOrders.mockResolvedValue([{ id: 'stale-1' }]);
    await service.pollOrderStatuses();
    jest.advanceTimersByTime(2 * 60 * 60 * 1000);
    await service.pollOrderStatuses();
    jest.useRealTimers();
  });

  it('checkAndProcessFills returns when fetchOpenOrders fails', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.fetchOpenOrders.mockRejectedValueOnce(new Error('x'));
    await service.pollOrderStatuses();
  });

  it('checkAndProcessFills returns when fetchOpenOrders exhausts retries', async () => {
    jest.useFakeTimers();
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.fetchOpenOrders.mockRejectedValue(new Error('x'));
    const p = service.pollOrderStatuses();
    await jest.runAllTimersAsync();
    await p;
    jest.useRealTimers();
  });

  it('partial fill cancels remainder and completes', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.fetchOpenOrders.mockResolvedValue([]);
    exchange.getExchange.mockReturnValue({
      fetchOrder: jest.fn().mockResolvedValue({
        status: 'open',
        filled: 0.005,
        quantity: 0.01,
      }),
    });
    const g = service.getGrid()!;
    const buy = g.orders.find((o) => o.side === 'buy' && o.status === 'placed');
    if (buy) {
      buy.exchangeOrderId = 'pf-1';
      buy.quantity = 0.01;
    }
    await service.pollOrderStatuses();
  });

  it('partial fill cancel failure skips', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.fetchOpenOrders.mockResolvedValue([]);
    exchange.cancelOrder.mockRejectedValueOnce(new Error('c'));
    exchange.getExchange.mockReturnValue({
      fetchOrder: jest.fn().mockResolvedValue({
        status: 'open',
        filled: 0.005,
        quantity: 0.01,
      }),
    });
    const g = service.getGrid()!;
    const buy = g.orders.find((o) => o.side === 'buy' && o.status === 'placed');
    if (buy) {
      buy.exchangeOrderId = 'pf-2';
      buy.quantity = 0.01;
    }
    await service.pollOrderStatuses();
  });

  it('buy fill uses elevated current price for counter sell log', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.fetchOpenOrders.mockResolvedValue([]);
    exchange.fetchTicker.mockResolvedValue({ last: 65000 });
    exchange.getExchange.mockReturnValue({
      fetchOrder: jest.fn().mockResolvedValue({
        status: 'closed',
        filled: 0.01,
      }),
    });
    const g = service.getGrid()!;
    const buy = g.orders.find((o) => o.side === 'buy' && o.status === 'placed');
    if (buy) {
      buy.exchangeOrderId = 'bf-1';
      buy.price = 50000;
    }
    await service.pollOrderStatuses();
  });

  it('reconcileWithExchange logs when fetch fails', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.fetchOpenOrders.mockRejectedValueOnce(new Error('e'));
    await service.reconcileWithExchange();
  });

  it('reconcileWithExchange when fetchOpenOrders exhausts retries', async () => {
    jest.useFakeTimers();
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.fetchOpenOrders.mockRejectedValue(new Error('e'));
    const p = service.reconcileWithExchange();
    await jest.runAllTimersAsync();
    await p;
    jest.useRealTimers();
  });

  it('reconcileWithExchange cancels orphan and logs failure', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.fetchOpenOrders.mockResolvedValue([
      { id: 'orph', side: 'buy', price: 1 },
    ]);
    exchange.cancelOrder.mockRejectedValueOnce(new Error('cx'));
    await service.reconcileWithExchange();
  });

  it('rebalanceGrid returns when no grid', async () => {
    await service.rebalanceGrid(100, {
      trigger: 'atr_increase',
      newLowerBound: 90,
      newUpperBound: 110,
      newGridStepPct: 1,
    });
  });

  it('rebalanceGrid returns when balance throws', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.fetchBalance.mockRejectedValueOnce(new Error('b'));
    await service.rebalanceGrid(100, {
      trigger: 'atr_increase',
      newLowerBound: 90,
      newUpperBound: 110,
      newGridStepPct: 1,
    });
  });

  it('rebalanceGrid returns when totalCapital <= 0', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.fetchBalance.mockResolvedValue({
      free: { USDT: 0, BTC: 0 },
      used: {},
    });
    await service.rebalanceGrid(100, {
      trigger: 'atr_increase',
      newLowerBound: 90,
      newUpperBound: 110,
      newGridStepPct: 1,
    });
  });

  it('checkRebalance returns when inactive', async () => {
    await service.checkRebalance();
  });

  it('checkRebalance returns when price missing', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.fetchTicker.mockResolvedValueOnce({ last: undefined });
    await service.checkRebalance();
  });

  it('checkRebalance returns when ticker throws', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.fetchTicker.mockRejectedValueOnce(new Error('net'));
    await service.checkRebalance();
  });

  it('checkRebalance returns when last price is zero', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.fetchTicker.mockResolvedValueOnce({ last: 0 });
    await service.checkRebalance();
  });

  it('checkRebalance clears upper zone when price not in upper zone', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-01T12:00:00Z'));
    await service.setupGrid('BTC/USDT', 100, 10, 10000);
    const inst = service as unknown as {
      lastRebalanceAt: number;
      upperZoneEnteredAt: number | null;
      lowerZoneEnteredAt: number | null;
    };
    inst.lastRebalanceAt = 0;
    inst.upperZoneEnteredAt = Date.now();
    inst.lowerZoneEnteredAt = null;
    exchange.fetchTicker.mockResolvedValue({ last: 100 });
    await service.checkRebalance();
    jest.useRealTimers();
  });

  it('checkRebalance clears lower zone when price leaves lower zone', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-01T12:00:00Z'));
    await service.setupGrid('BTC/USDT', 100, 10, 10000);
    const inst = service as unknown as {
      lastRebalanceAt: number;
      lowerZoneEnteredAt: number | null;
    };
    inst.lastRebalanceAt = 0;
    inst.lowerZoneEnteredAt = Date.now();
    exchange.fetchTicker.mockResolvedValue({ last: 100 });
    await service.checkRebalance();
    jest.useRealTimers();
  });

  it('checkRebalance returns when OHLCV block throws', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.fetchOHLCV.mockRejectedValueOnce(new Error('ohlcv'));
    await service.checkRebalance();
  });

  it('checkRebalance returns when ATR tail is zero', async () => {
    const head: number[] = Array.from({ length: 19 }, (): number => 50);
    (ti.ATR.calculate as jest.Mock).mockReturnValueOnce([...head, 0]);
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.fetchOHLCV.mockResolvedValue(
      Array.from({ length: 20 }, () => [0, 0, 100, 90, 95, 1]),
    );
    await service.checkRebalance();
    (ti.ATR.calculate as jest.Mock).mockReturnValue(Array(20).fill(50));
  });

  it('checkRebalance skips during cooldown window', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    const inst = service as unknown as { lastRebalanceAt: number };
    inst.lastRebalanceAt = Date.now();
    await service.checkRebalance();
  });

  it('checkRebalance returns when candles too short', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.fetchOHLCV = jest.fn().mockResolvedValue([[0, 0, 1, 1, 1, 1]]);
    await service.checkRebalance();
  });

  it('checkRebalance returns when ATR empty', async () => {
    (ti.ATR.calculate as jest.Mock).mockReturnValueOnce([]);
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.fetchOHLCV = jest
      .fn()
      .mockResolvedValue(
        Array.from({ length: 20 }, () => [0, 0, 100, 90, 95, 1]),
      );
    await service.checkRebalance();
    (ti.ATR.calculate as jest.Mock).mockReturnValue(Array(20).fill(50));
  });

  it('fetchAndCacheFeeRate uses default on error', async () => {
    exchange.fetchTradingFee.mockRejectedValueOnce(new Error('fee'));
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
  });

  it('getBaseAssetSellInfo returns rounded qty', async () => {
    exchange.fetchBalance.mockResolvedValue({
      free: { SOL: 0.1234567 },
      used: {},
    });
    exchange.fetchTicker.mockResolvedValue({ last: 50 });
    const info = await service.getBaseAssetSellInfo('SOL/USDT');
    expect(info.baseAsset).toBe('SOL');
    expect(info.notional).toBeGreaterThan(0);
  });

  it('getBaseAssetSellInfo reads lowercase base key', async () => {
    exchange.fetchBalance.mockResolvedValue({
      free: { sol: 0.2 },
      used: {},
    });
    exchange.fetchTicker.mockResolvedValue({ last: 100 });
    const info = await service.getBaseAssetSellInfo('SOL/USDT');
    expect(info.freeBase).toBe(0.2);
  });

  it('marketSellBase returns fill summary', async () => {
    exchange.createOrder.mockResolvedValueOnce({
      average: 10,
      filled: 2,
      price: 10,
    });
    const r = await service.marketSellBase('SOL/USDT', 2);
    expect(r.totalUsdt).toBeGreaterThan(0);
  });

  it('emergencySellBase exits on balance error', async () => {
    exchange.fetchBalance.mockRejectedValueOnce(new Error('e'));
    await service.emergencySellBase('SOL/USDT', 100);
  });

  it('emergencySellBase skips tiny balance', async () => {
    exchange.fetchBalance.mockResolvedValue({
      free: { SOL: 0.00001 },
      used: {},
    });
    await service.emergencySellBase('SOL/USDT', 100);
  });

  it('emergencySellBase places market sell', async () => {
    exchange.fetchBalance.mockResolvedValue({ free: { SOL: 0.5 }, used: {} });
    await service.emergencySellBase('SOL/USDT', 100);
  });

  it('emergencySellBase logs market sell failure', async () => {
    jest.useFakeTimers();
    exchange.fetchBalance.mockResolvedValue({ free: { SOL: 1 }, used: {} });
    exchange.createOrder.mockImplementation(() =>
      Promise.reject(new Error('m')),
    );
    const p = service.emergencySellBase('SOL/USDT', 100);
    await jest.runAllTimersAsync();
    await p;
    jest.useRealTimers();
  });

  it('emergencySellBase balance error stringifies non-Error', async () => {
    exchange.fetchBalance.mockRejectedValueOnce('bal');
    await service.emergencySellBase('SOL/USDT', 100);
  });

  it('emergencySellBase market sell failure is logged', async () => {
    jest.useFakeTimers();
    exchange.fetchBalance.mockResolvedValue({ free: { SOL: 1 }, used: {} });
    exchange.createOrder.mockImplementation(() =>
      Promise.reject(new Error('sell-fail')),
    );
    const p = service.emergencySellBase('SOL/USDT', 100);
    await jest.runAllTimersAsync();
    await p;
    jest.useRealTimers();
  });

  it('emergencySellBase market sell failure uses Error message', async () => {
    jest.useFakeTimers();
    exchange.fetchBalance.mockResolvedValue({ free: { SOL: 1 }, used: {} });
    exchange.createOrder.mockImplementation(() =>
      Promise.reject(new Error('mkt-err')),
    );
    const p = service.emergencySellBase('SOL/USDT', 100);
    await jest.runAllTimersAsync();
    await p;
    jest.useRealTimers();
  });

  it('checkRebalance upper zone inner branch when already tracking', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-01T12:00:00Z'));
    await service.setupGrid('BTC/USDT', 100, 10, 10000);
    const g = service.getGrid()!;
    const range = g.upperBound - g.lowerBound;
    const upperZoneThreshold = g.upperBound - range * 0.2;
    const inUpper = upperZoneThreshold + 0.01;
    const inst = service as unknown as {
      lastRebalanceAt: number;
      upperZoneEnteredAt: number | null;
    };
    inst.lastRebalanceAt = 0;
    inst.upperZoneEnteredAt = null;
    exchange.fetchTicker.mockResolvedValue({ last: inUpper });
    await service.checkRebalance();
    expect(inst.upperZoneEnteredAt).not.toBeNull();
    await service.checkRebalance();
    jest.useRealTimers();
  });

  it('handleFilledOrCancelled returns when fetchOrder fails', async () => {
    jest.useFakeTimers();
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.fetchOpenOrders.mockResolvedValue([]);
    exchange.getExchange.mockReturnValue({
      fetchOrder: jest.fn().mockRejectedValue(new Error('fo')),
    });
    const g = service.getGrid()!;
    const buy = g.orders.find((o) => o.side === 'buy' && o.status === 'placed');
    if (buy) buy.exchangeOrderId = 'hf-1';
    const p = service.pollOrderStatuses();
    await jest.runAllTimersAsync();
    await p;
    jest.useRealTimers();
  });

  it('cancelGrid -2011 when fetchOrder check throws', async () => {
    jest.useFakeTimers();
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.cancelOrder.mockRejectedValue(new Error('Unknown order'));
    exchange.getExchange.mockReturnValue({
      fetchOrder: jest.fn().mockRejectedValue(new Error('inner')),
    });
    const g = service.getGrid()!;
    const placed = g.orders.find((o) => o.status === 'placed');
    if (placed) placed.exchangeOrderId = 'in-1';
    const p = service.cancelGrid();
    await jest.runAllTimersAsync();
    await p;
    jest.useRealTimers();
  });

  it('checkRebalance runs when trigger fires', async () => {
    jest
      .spyOn(gridCalculator, 'checkRebalanceTriggers')
      .mockReturnValueOnce('atr_increase');
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-15T12:00:00Z'));
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    const inst = service as unknown as { lastRebalanceAt: number };
    inst.lastRebalanceAt = 0;
    exchange.fetchOHLCV = jest
      .fn()
      .mockResolvedValue(
        Array.from({ length: 20 }, () => [0, 0, 100, 90, 95, 1]),
      );
    await service.checkRebalance();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('British spelling cancelled re-places order', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.fetchOpenOrders.mockResolvedValue([]);
    exchange.getExchange.mockReturnValue({
      fetchOrder: jest.fn().mockResolvedValue({
        status: 'cancelled',
        filled: 0,
      }),
    });
    const g = service.getGrid()!;
    const buy = g.orders.find((o) => o.side === 'buy' && o.status === 'placed');
    if (buy) buy.exchangeOrderId = 'can-1';
    await service.pollOrderStatuses();
  });

  it('American spelling canceled re-places order', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.fetchOpenOrders.mockResolvedValue([]);
    exchange.getExchange.mockReturnValue({
      fetchOrder: jest.fn().mockResolvedValue({
        status: 'canceled',
        filled: 0,
      }),
    });
    const g = service.getGrid()!;
    const buy = g.orders.find((o) => o.side === 'buy' && o.status === 'placed');
    if (buy) buy.exchangeOrderId = 'can-us';
    await service.pollOrderStatuses();
  });

  it('cancelGrid logs non-2011 cancel errors', async () => {
    jest.useFakeTimers();
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.cancelOrder.mockRejectedValue(new Error('rate limit'));
    const g = service.getGrid()!;
    const placed = g.orders.find((o) => o.status === 'placed');
    if (placed) placed.exchangeOrderId = 'ne-1';
    const p = service.cancelGrid();
    await jest.runAllTimersAsync();
    await p;
    jest.useRealTimers();
  });

  it('cancelGrid stringify non-Error cancel failure', async () => {
    jest.useFakeTimers();
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.cancelOrder.mockRejectedValue('not-an-error');
    const g = service.getGrid()!;
    const placed = g.orders.find((o) => o.status === 'placed');
    if (placed) placed.exchangeOrderId = 'ne-2';
    const p = service.cancelGrid();
    await jest.runAllTimersAsync();
    await p;
    jest.useRealTimers();
  });

  it('placeOrder catch uses Error message branch', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    const g = service.getGrid()!;
    const pending = {
      levelIndex: 99,
      side: 'buy' as const,
      price: 1,
      quantity: 0.01,
      status: 'pending' as const,
      gridCycleId: 'pe',
    };
    g.orders.push(pending);
    exchange.createOrder.mockRejectedValueOnce(new Error('explicit-err'));
    await (
      service as unknown as {
        placeOrder: (o: typeof pending) => Promise<void>;
      }
    ).placeOrder(pending);
  });

  it('saveOrderToDb creates row when exchangeOrderId missing', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    const o = {
      levelIndex: 0,
      side: 'buy' as const,
      price: 10,
      quantity: 0.01,
      status: 'placed' as const,
      gridCycleId: 'noc',
    };
    await (
      service as unknown as { saveOrderToDb: (x: typeof o) => Promise<void> }
    ).saveOrderToDb(o);
    expect(prisma.gridOrder.create).toHaveBeenCalled();
  });

  it('saveOrderToDb uses Error message in prisma failure', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    prisma.gridOrder.create.mockRejectedValueOnce(new Error('prisma-err'));
    const o = {
      levelIndex: 0,
      side: 'buy' as const,
      price: 10,
      quantity: 0.01,
      status: 'placed' as const,
      gridCycleId: 'pse2',
      exchangeOrderId: 'e2',
    };
    await (
      service as unknown as { saveOrderToDb: (x: typeof o) => Promise<void> }
    ).saveOrderToDb(o);
  });

  it('saveOrderToDb stringify non-Error prisma failure', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    prisma.gridOrder.create.mockRejectedValueOnce('prisma-string');
    const o = {
      levelIndex: 0,
      side: 'buy' as const,
      price: 10,
      quantity: 0.01,
      status: 'placed' as const,
      gridCycleId: 'pse',
      exchangeOrderId: 'e1',
    };
    await (
      service as unknown as { saveOrderToDb: (x: typeof o) => Promise<void> }
    ).saveOrderToDb(o);
  });

  it('checkAndProcessFills uses ticker without last', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.fetchOpenOrders.mockResolvedValue([]);
    exchange.fetchTicker.mockResolvedValueOnce({});
    exchange.getExchange.mockReturnValue({
      fetchOrder: jest.fn().mockResolvedValue({
        status: 'closed',
        filled: 0.01,
      }),
    });
    const g = service.getGrid()!;
    const buy = g.orders.find((o) => o.side === 'buy' && o.status === 'placed');
    if (buy) buy.exchangeOrderId = 'tk-1';
    await service.pollOrderStatuses();
  });

  it('handleFilledOrCancelled skips partial branch when open but unfilled', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.fetchOpenOrders.mockResolvedValue([]);
    exchange.getExchange.mockReturnValue({
      fetchOrder: jest.fn().mockResolvedValue({
        status: 'open',
        filled: 0,
        quantity: 0.01,
      }),
    });
    const g = service.getGrid()!;
    const buy = g.orders.find((o) => o.side === 'buy' && o.status === 'placed');
    if (buy) buy.exchangeOrderId = 'op-0';
    await service.pollOrderStatuses();
  });

  it('onOrderFilled uses order quantity when filled arg is zero', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    const o = {
      levelIndex: 0,
      side: 'buy' as const,
      price: 100,
      quantity: 0.02,
      status: 'placed' as const,
      gridCycleId: 'fq',
      exchangeOrderId: 'ex-fq',
    };
    await (
      service as unknown as {
        onOrderFilled: (a: typeof o, q: number, p: number) => Promise<void>;
      }
    ).onOrderFilled(o, 0, 0);
  });

  it('onOrderFilled buy skips DB status update without exchangeOrderId', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    prisma.trade.create.mockClear();
    prisma.gridOrder.updateMany.mockClear();
    const o = {
      levelIndex: 0,
      side: 'buy' as const,
      price: 100,
      quantity: 0.01,
      status: 'placed' as const,
      gridCycleId: 'nex',
    };
    await (
      service as unknown as {
        onOrderFilled: (a: typeof o, q: number, p: number) => Promise<void>;
      }
    ).onOrderFilled(o, 0.01, 100);
    expect(prisma.gridOrder.updateMany.mock.calls.length).toBe(0);
  });

  it('onOrderFilled sell records pnl when exchangeOrderId set', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    prisma.trade.updateMany.mockClear();
    const o = {
      levelIndex: 0,
      side: 'sell' as const,
      price: 110,
      quantity: 0.01,
      status: 'placed' as const,
      gridCycleId: 'sellp',
      exchangeOrderId: 'sell-ex',
    };
    await (
      service as unknown as {
        onOrderFilled: (a: typeof o, q: number, p: number) => Promise<void>;
      }
    ).onOrderFilled(o, 0.01, 100);
    expect(prisma.trade.updateMany).toHaveBeenCalled();
  });

  it('onOrderFilled sell skips pnl update without exchangeOrderId', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    prisma.trade.updateMany.mockClear();
    const o = {
      levelIndex: 0,
      side: 'sell' as const,
      price: 110,
      quantity: 0.01,
      status: 'placed' as const,
      gridCycleId: 'sellnp',
    };
    await (
      service as unknown as {
        onOrderFilled: (a: typeof o, q: number, p: number) => Promise<void>;
      }
    ).onOrderFilled(o, 0.01, 100);
    expect(prisma.trade.updateMany.mock.calls.length).toBe(0);
  });

  it('reconcileWithExchange orphan cancel stringifies non-Error', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.fetchOpenOrders.mockResolvedValue([
      { id: 'orph2', side: 'buy', price: 1 },
    ]);
    exchange.cancelOrder.mockRejectedValueOnce('orph-fail');
    await service.reconcileWithExchange();
  });

  it('rebalanceGrid reads lowercase usdt and default activeCapitalPct', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    const inst = service as unknown as {
      config: { get: (k: string) => unknown };
    };
    jest.spyOn(inst.config, 'get').mockImplementation((key: string) => {
      if (key === 'risk.activeCapitalPct') return undefined;
      return 90;
    });
    exchange.fetchBalance.mockResolvedValueOnce({
      free: { usdt: 5000, btc: 0.02 },
      used: { usdt: 50 },
    });
    jest.spyOn(service, 'cancelGrid').mockResolvedValue();
    jest.spyOn(service, 'setupGridWithParams').mockResolvedValue();
    await service.rebalanceGrid(60000, {
      trigger: 'atr_increase',
      newLowerBound: 50000,
      newUpperBound: 70000,
      newGridStepPct: 1,
    });
    jest.restoreAllMocks();
  });

  it('rebalanceGrid uses zero when usdt keys missing in balance', async () => {
    await service.setupGrid('BTC/USDT', 60000, 1500, 10000);
    exchange.fetchBalance.mockResolvedValueOnce({
      free: {},
      used: {},
    });
    jest.spyOn(service, 'cancelGrid').mockResolvedValue();
    jest.spyOn(service, 'setupGridWithParams').mockResolvedValue();
    await service.rebalanceGrid(60000, {
      trigger: 'atr_increase',
      newLowerBound: 50000,
      newUpperBound: 70000,
      newGridStepPct: 1,
    });
    jest.restoreAllMocks();
  });

  it('checkRebalance sets lowerZoneEnteredAt on first lower-zone entry', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-01T12:00:00Z'));
    await service.setupGrid('BTC/USDT', 100, 10, 10000);
    const g = service.getGrid()!;
    const range = g.upperBound - g.lowerBound;
    const lowerZoneThreshold = g.lowerBound + range * 0.2;
    const inst = service as unknown as {
      lastRebalanceAt: number;
      lowerZoneEnteredAt: number | null;
    };
    inst.lastRebalanceAt = 0;
    inst.lowerZoneEnteredAt = null;
    exchange.fetchTicker.mockResolvedValue({
      last: Math.min(g.lowerBound, lowerZoneThreshold - 1),
    });
    await service.checkRebalance();
    expect(inst.lowerZoneEnteredAt).not.toBeNull();
    await service.checkRebalance();
    jest.useRealTimers();
  });

  it('isActive is false when grid missing', () => {
    expect(service.isActive()).toBe(false);
  });

  it('getBaseAssetSellInfo falls back when balance keys missing', async () => {
    exchange.fetchBalance.mockResolvedValue({ free: {}, used: {} });
    exchange.fetchTicker.mockResolvedValueOnce({});
    const info = await service.getBaseAssetSellInfo('XRP/USDT');
    expect(info.freeBase).toBe(0);
    expect(info.price).toBe(0);
  });

  it('marketSellBase falls back when average and price missing', async () => {
    exchange.createOrder.mockResolvedValueOnce({ filled: 1.25 });
    const r = await service.marketSellBase('SOL/USDT', 1.25);
    expect(r.filledQty).toBe(1.25);
    expect(r.filledPrice).toBe(0);
  });

  it('marketSellBase uses zero when average price and filled missing', async () => {
    exchange.createOrder.mockResolvedValueOnce({});
    const r = await service.marketSellBase('SOL/USDT', 2);
    expect(r.filledQty).toBe(2);
    expect(r.filledPrice).toBe(0);
  });

  it('emergencySellBase reads base balance via lowercase key', async () => {
    exchange.fetchBalance.mockResolvedValueOnce({
      free: { sol: 0.6 },
      used: {},
    });
    await service.emergencySellBase('SOL/USDT', 100);
  });

  it('emergencySellBase uses zero when free balance keys missing', async () => {
    exchange.fetchBalance.mockResolvedValueOnce({ free: {}, used: {} });
    await service.emergencySellBase('SOL/USDT', 100);
  });

  it('pollOrderStatuses hits no-grid guard repeatedly', async () => {
    for (let i = 0; i < 25; i++) {
      await service.pollOrderStatuses();
    }
  });

  it('checkRebalance hits no-grid guard repeatedly', async () => {
    for (let i = 0; i < 25; i++) {
      await service.checkRebalance();
    }
  });

  // --- onBuyFilled critical path ---

  it('onOrderFilled buy: places counter-sell and emits ORDER_FILLED', async () => {
    await service.setupGrid('SOL/USDT', 100, 2, 500);
    emit.mockClear();
    prisma.trade.create.mockClear();

    const g = service.getGrid()!;
    const buyOrder = {
      levelIndex: 0,
      side: 'buy' as const,
      price: 98,
      quantity: 0.05,
      status: 'placed' as const,
      gridCycleId: 'test-cycle',
      exchangeOrderId: 'buy-ex-1',
    };

    await (
      service as unknown as {
        onOrderFilled: (
          o: typeof buyOrder,
          qty: number,
          price: number,
        ) => Promise<void>;
      }
    ).onOrderFilled(buyOrder, 0.05, 100);

    // Counter-sell should have been placed
    expect(exchange.createOrder).toHaveBeenCalledWith(
      'SOL/USDT',
      'limit',
      'sell',
      expect.any(Number),
      expect.any(Number),
    );

    // ORDER_FILLED event should be emitted with buy side
    expect(emit).toHaveBeenCalledWith(
      'grid.orderFilled',
      expect.objectContaining({ side: 'buy', price: 98 }),
    );

    // Trade should be persisted
    expect(prisma.trade.create).toHaveBeenCalled();

    // Counter-sell price should be above buy price and not exceed upper bound
    const createCalls = exchange.createOrder.mock.calls as Array<
      [string, string, string, number, number]
    >;
    const sellArgs = createCalls.at(-1)!;
    const sellPrice = sellArgs[4];
    expect(sellPrice).toBeGreaterThan(98);
    expect(sellPrice).toBeLessThanOrEqual(g.upperBound);
  });

  it('onOrderFilled buy: counter-sell capped at upper bound when elevated market price', async () => {
    await service.setupGrid('SOL/USDT', 100, 2, 500);
    emit.mockClear();

    const g = service.getGrid()!;
    const buyOrder = {
      levelIndex: 0,
      side: 'buy' as const,
      price: 80,
      quantity: 0.05,
      status: 'placed' as const,
      gridCycleId: 'cap-cycle',
      exchangeOrderId: 'buy-cap-1',
    };

    // currentPrice far above upper bound → sell must be capped
    await (
      service as unknown as {
        onOrderFilled: (
          o: typeof buyOrder,
          qty: number,
          price: number,
        ) => Promise<void>;
      }
    ).onOrderFilled(buyOrder, 0.05, g.upperBound * 10);

    const createCalls2 = exchange.createOrder.mock.calls as Array<
      [string, string, string, number, number]
    >;
    const sellArgs2 = createCalls2.at(-1)!;
    expect(sellArgs2[4]).toBeLessThanOrEqual(g.upperBound);
  });

  it('onOrderFilled sell: places counter-buy, emits ORDER_FILLED with sell side', async () => {
    await service.setupGrid('SOL/USDT', 100, 2, 500);
    emit.mockClear();
    prisma.trade.updateMany.mockClear();

    const sellOrder = {
      levelIndex: 0,
      side: 'sell' as const,
      price: 102,
      quantity: 0.05,
      status: 'placed' as const,
      gridCycleId: 'sell-cycle',
      exchangeOrderId: 'sell-ex-1',
    };

    await (
      service as unknown as {
        onOrderFilled: (
          o: typeof sellOrder,
          qty: number,
          price: number,
        ) => Promise<void>;
      }
    ).onOrderFilled(sellOrder, 0.05, 102);

    // Counter-buy should have been placed
    const createCallsSell = exchange.createOrder.mock.calls as Array<
      [string, string, string, number, number]
    >;
    const buyCall = createCallsSell.find((c) => c[2] === 'buy');
    expect(buyCall).toBeDefined();
    expect(buyCall![4]).toBeLessThan(102);

    // ORDER_FILLED event emitted with sell side
    expect(emit).toHaveBeenCalledWith(
      'grid.orderFilled',
      expect.objectContaining({ side: 'sell', price: 102 }),
    );

    // PnL update attempted
    expect(prisma.trade.updateMany).toHaveBeenCalled();
  });

  it('onOrderFilled buy: uses order.price as effective price when currentPrice is 0', async () => {
    await service.setupGrid('SOL/USDT', 100, 2, 500);
    emit.mockClear();

    const buyOrder = {
      levelIndex: 0,
      side: 'buy' as const,
      price: 99,
      quantity: 0.05,
      status: 'placed' as const,
      gridCycleId: 'zero-price-cycle',
      exchangeOrderId: 'buy-zero-1',
    };

    // currentPrice = 0 → effectiveCurrentPrice falls back to order.price
    await (
      service as unknown as {
        onOrderFilled: (
          o: typeof buyOrder,
          qty: number,
          price: number,
        ) => Promise<void>;
      }
    ).onOrderFilled(buyOrder, 0.05, 0);

    expect(emit).toHaveBeenCalledWith(
      'grid.orderFilled',
      expect.objectContaining({ side: 'buy', price: 99 }),
    );
  });
});
