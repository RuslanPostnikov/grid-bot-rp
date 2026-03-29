/**
 * Integration tests for GridService order persistence logic.
 *
 * Uses stateful in-memory mocks that simulate DB and exchange behaviour,
 * letting us test the full lifecycle without a real database connection.
 *
 * Scenarios covered:
 *  1. setupGrid  → orders saved to DB with status='placed' + exchangeOrderId
 *  2. onModuleInit (restart) → orders restored from DB, reconciled with exchange
 *  3. Buy fill  → order marked 'filled' in DB, sell counter-order saved
 *  4. cancelGrid → all active orders marked 'cancelled' in DB
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { GridService } from '@src/modules/grid/grid.service.js';
import { ConfigService } from '@nestjs/config';
import { ExchangeService } from '@src/modules/exchange/exchange.service.js';
import { PrismaService } from '@src/prisma.service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGridOrderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BigInt(Math.floor(Math.random() * 1_000_000)),
    gridStateId: BigInt(1),
    levelIndex: 0,
    side: 'buy',
    price: 60000,
    quantity: 0.01,
    status: 'placed',
    exchangeOrderId: 'ex-order-1',
    gridCycleId: 'cycle-1',
    placedAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Stateful DB mock
// ---------------------------------------------------------------------------

function createStatefulPrisma() {
  let gridStateRow: Record<string, unknown> | null = null;
  const gridOrderRows: Map<
    string,
    ReturnType<typeof makeGridOrderRow>
  > = new Map();

  const gridState = {
    findFirst: jest.fn((args: { include?: { orders?: boolean } } = {}) => {
      if (!gridStateRow) return null;
      return {
        ...gridStateRow,
        orders: args.include?.orders ? [...gridOrderRows.values()] : undefined,
      };
    }),
    create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
      gridStateRow = { id: BigInt(1), ...data };
      return gridStateRow;
    }),
    update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
      if (gridStateRow) Object.assign(gridStateRow, data);
      return gridStateRow;
    }),
  };

  const gridOrder = {
    create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
      const row = makeGridOrderRow(data);
      const key = (data.exchangeOrderId as string) ?? String(row.id);
      gridOrderRows.set(key, row);
      return row;
    }),
    findFirst: jest.fn(
      ({
        where,
      }: {
        where: { gridStateId: bigint; exchangeOrderId?: string };
      }) => {
        for (const row of gridOrderRows.values()) {
          if (
            row.exchangeOrderId === where.exchangeOrderId &&
            row.gridStateId === where.gridStateId
          ) {
            return row;
          }
        }
        return null;
      },
    ),
    update: jest.fn(
      ({
        where,
        data,
      }: {
        where: { id: bigint };
        data: Record<string, unknown>;
      }) => {
        for (const row of gridOrderRows.values()) {
          if (row.id === where.id) {
            Object.assign(row, data);
            return row;
          }
        }
      },
    ),
    updateMany: jest.fn(
      ({
        where,
        data,
      }: {
        where: {
          exchangeOrderId?: string;
          gridStateId?: bigint;
          status?: { in: string[] };
        };
        data: Record<string, unknown>;
      }) => {
        let count = 0;
        for (const row of gridOrderRows.values()) {
          const matchesExId =
            !where.exchangeOrderId ||
            row.exchangeOrderId === where.exchangeOrderId;
          const matchesGridState =
            !where.gridStateId || row.gridStateId === where.gridStateId;
          const matchesStatus =
            !where.status?.in || where.status.in.includes(row.status);
          if (matchesExId && matchesGridState && matchesStatus) {
            Object.assign(row, data);
            count++;
          }
        }
        return { count };
      },
    ),

    // Expose internal state for assertions
    _rows: gridOrderRows,
  };

  const trade = {
    create: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({}),
    findMany: jest.fn().mockResolvedValue([]),
  };

  const decisionLog = { create: jest.fn().mockResolvedValue({}) };

  return { gridState, gridOrder, trade, decisionLog };
}

// ---------------------------------------------------------------------------
// Exchange mock factory
// ---------------------------------------------------------------------------

function createExchangeMock(openOrderIds: string[] = []) {
  let orderIdCounter = 0;
  return {
    createOrder: jest
      .fn()
      .mockImplementation(() =>
        Promise.resolve({ id: `ex-order-${++orderIdCounter}`, status: 'open' }),
      ),
    cancelOrder: jest.fn().mockResolvedValue({ status: 'cancelled' }),
    fetchOpenOrders: jest
      .fn()
      .mockResolvedValue(openOrderIds.map((id) => ({ id }))),
    fetchBalance: jest.fn().mockResolvedValue({
      free: { BTC: 0, USDT: 0 },
      used: {},
    }),
    getExchange: jest.fn().mockReturnValue({
      fetchOrder: jest.fn().mockResolvedValue({
        status: 'open',
        filled: 0,
      }),
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GridService — order persistence', () => {
  let service: GridService;
  let exchange: ReturnType<typeof createExchangeMock>;
  let prisma: ReturnType<typeof createStatefulPrisma>;

  async function buildModule(
    exchangeOverride?: Partial<ReturnType<typeof createExchangeMock>>,
    prismaOverride?: ReturnType<typeof createStatefulPrisma>,
  ) {
    exchange = { ...createExchangeMock(), ...exchangeOverride };
    prisma = prismaOverride ?? createStatefulPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GridService,
        { provide: ExchangeService, useValue: exchange },
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(90) },
        },
      ],
    }).compile();

    service = module.get<GridService>(GridService);
    // NestJS test compile() does not auto-call onModuleInit — call explicitly
    await service.onModuleInit();
    return service;
  }

  // ── 1. Setup saves orders to DB ──────────────────────────────────────────

  describe('1. setupGrid saves orders to DB', () => {
    beforeEach(() => buildModule());

    it('creates a GridState record', async () => {
      await service.setupGrid('BTC/USDT', 60000, 1500, 1000);
      expect(prisma.gridState.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            pair: 'BTC/USDT',
            active: true,
          }) as object,
        }),
      );
    });

    it('saves each placed order to DB with exchangeOrderId', async () => {
      await service.setupGrid('BTC/USDT', 60000, 1500, 1000);

      expect(prisma.gridOrder.create).toHaveBeenCalled();

      // Every saved row must have an exchangeOrderId (placed on exchange)
      for (const row of prisma.gridOrder._rows.values()) {
        expect(row.exchangeOrderId).toBeTruthy();
        expect(row.status).toBe('placed');
      }
    });

    it('saved orders match in-memory grid orders', async () => {
      await service.setupGrid('BTC/USDT', 60000, 1500, 1000);
      const grid = service.getGrid()!;

      const placedInMemory = grid.orders.filter(
        (o) => o.status === 'placed' && o.exchangeOrderId,
      );
      const savedInDb = [...prisma.gridOrder._rows.values()];

      expect(savedInDb.length).toBe(placedInMemory.length);

      for (const mem of placedInMemory) {
        const dbRow = savedInDb.find(
          (r) => r.exchangeOrderId === mem.exchangeOrderId,
        );
        expect(dbRow).toBeDefined();
        expect(Number(dbRow!.price)).toBeCloseTo(mem.price, 0);
        expect(dbRow!.side).toBe(mem.side);
      }
    });
  });

  // ── 2. onModuleInit restores orders from DB ──────────────────────────────

  describe('2. onModuleInit restores orders from DB after restart', () => {
    it('restores placed orders and marks grid as active', async () => {
      // Pre-populate DB with an active grid + one placed order
      const sharedPrisma = createStatefulPrisma();
      sharedPrisma.gridState.create({
        data: {
          pair: 'BTC/USDT',
          lowerBound: 55500,
          upperBound: 64500,
          gridStepPct: 4,
          levelsCount: 2,
          capitalUsdt: 1000,
          active: true,
          updatedAt: new Date(),
        },
      });
      sharedPrisma.gridOrder._rows.set(
        'ex-order-99',
        makeGridOrderRow({ exchangeOrderId: 'ex-order-99', status: 'placed' }),
      );

      // Exchange still has that order open
      const sharedExchange = createExchangeMock(['ex-order-99']);

      await buildModule(sharedExchange, sharedPrisma);

      expect(service.isActive()).toBe(true);
      const grid = service.getGrid()!;
      expect(grid.pair).toBe('BTC/USDT');

      // Restored order must be present in memory
      const restored = grid.orders.find(
        (o) => o.exchangeOrderId === 'ex-order-99',
      );
      expect(restored).toBeDefined();
      expect(restored!.status).toBe('placed');
    });

    it('detects fills that happened while bot was offline', async () => {
      const sharedPrisma = createStatefulPrisma();
      sharedPrisma.gridState.create({
        data: {
          pair: 'BTC/USDT',
          lowerBound: 55500,
          upperBound: 64500,
          gridStepPct: 4,
          levelsCount: 2,
          capitalUsdt: 1000,
          active: true,
          updatedAt: new Date(),
        },
      });
      sharedPrisma.gridOrder._rows.set(
        'ex-offline-fill',
        makeGridOrderRow({
          exchangeOrderId: 'ex-offline-fill',
          status: 'placed',
          side: 'buy',
          price: 58000,
          quantity: 0.01,
        }),
      );

      // Exchange: order is gone (filled while bot was down)
      const sharedExchange = createExchangeMock([]); // no open orders
      sharedExchange.getExchange.mockReturnValue({
        fetchOrder: jest.fn().mockResolvedValue({
          status: 'closed',
          filled: 0.01,
        }),
      });

      await buildModule(sharedExchange, sharedPrisma);

      // reconcileWithExchange should have processed the fill → placed counter sell
      expect(sharedExchange.createOrder).toHaveBeenCalledWith(
        'BTC/USDT',
        'limit',
        'sell',
        expect.any(Number),
        expect.any(Number),
      );
    });
  });

  // ── 3. Fill updates order status in DB ───────────────────────────────────

  describe('3. buy fill → DB updated, sell counter-order saved', () => {
    beforeEach(() => buildModule());

    it('marks buy order as filled in DB', async () => {
      await service.setupGrid('BTC/USDT', 60000, 1500, 1000);

      const grid = service.getGrid()!;
      const placedBuy = grid.orders.find((o) => o.side === 'buy')!;
      const buyExId = placedBuy.exchangeOrderId!;

      // Simulate: exchange no longer has this order (filled)
      exchange.fetchOpenOrders.mockResolvedValue([]);
      exchange.getExchange.mockReturnValue({
        fetchOrder: jest.fn().mockResolvedValue({
          status: 'closed',
          filled: placedBuy.quantity,
        }),
      });

      await service.pollOrderStatuses();

      // DB row must be updated to 'filled'
      const dbRow = prisma.gridOrder._rows.get(buyExId);
      expect(dbRow?.status).toBe('filled');
    });

    it('saves sell counter-order to DB after buy fill', async () => {
      await service.setupGrid('BTC/USDT', 60000, 1500, 1000);

      const grid = service.getGrid()!;
      const placedBuy = grid.orders.find((o) => o.side === 'buy')!;
      const dbRowsBefore = prisma.gridOrder._rows.size;

      exchange.fetchOpenOrders.mockResolvedValue([]);
      exchange.getExchange.mockReturnValue({
        fetchOrder: jest.fn().mockResolvedValue({
          status: 'closed',
          filled: placedBuy.quantity,
        }),
      });

      await service.pollOrderStatuses();

      // A new sell order row must have been created
      const dbRowsAfter = prisma.gridOrder._rows.size;
      expect(dbRowsAfter).toBeGreaterThan(dbRowsBefore);

      const sellRows = [...prisma.gridOrder._rows.values()].filter(
        (r) => r.side === 'sell' && r.status === 'placed',
      );
      expect(sellRows.length).toBeGreaterThan(0);
    });
  });

  // ── 4. cancelGrid marks all orders as cancelled in DB ────────────────────

  describe('4. cancelGrid marks all orders cancelled in DB', () => {
    beforeEach(() => buildModule());

    it('updates DB status to cancelled for all placed orders', async () => {
      await service.setupGrid('BTC/USDT', 60000, 1500, 1000);
      await service.cancelGrid();

      expect(prisma.gridOrder.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'cancelled' }) as object,
        }),
      );

      // All rows in DB are now cancelled
      for (const row of prisma.gridOrder._rows.values()) {
        expect(row.status).toBe('cancelled');
      }
    });

    it('marks grid state as inactive in DB', async () => {
      await service.setupGrid('BTC/USDT', 60000, 1500, 1000);
      await service.cancelGrid();

      expect(prisma.gridState.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ active: false }) as object,
        }),
      );
    });
  });
});
