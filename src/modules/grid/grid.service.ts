import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ExchangeService } from '../exchange/exchange.service.js';
import { PrismaService } from '../../prisma.service.js';
import { withRetry } from '../../common/retry.js';
import {
  calculateGridParams,
  calculateCapitalPerLevel,
  generateGridOrders,
  onBuyFilled,
  onSellFilled,
  calculateCyclePnl,
  isPriceInGrid,
} from './grid-calculator.js';
import type { GridOrder } from './grid.types.js';
import { randomUUID } from 'node:crypto';

const ORDER_POLL_MS = 15_000; // check order status every 15s

export interface ActiveGrid {
  pair: string;
  lowerBound: number;
  upperBound: number;
  gridStepPct: number;
  levelsCount: number;
  orders: ManagedOrder[];
  active: boolean;
  gridStateId: bigint | null;
}

export interface ManagedOrder extends GridOrder {
  exchangeOrderId?: string;
  gridCycleId: string;
  placedAt?: Date;
}

@Injectable()
export class GridService implements OnModuleInit {
  private readonly logger = new Logger(GridService.name);
  private grid: ActiveGrid | null = null;
  private processingOrders = false; // lock to prevent concurrent processing

  constructor(
    private readonly exchange: ExchangeService,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Restore active grid from DB on startup
    const activeGrid = await this.prisma.gridState.findFirst({
      where: { active: true },
      orderBy: { updatedAt: 'desc' },
    });

    if (activeGrid) {
      this.logger.log(`Restoring active grid for ${activeGrid.pair}, id=${activeGrid.id}`);
      this.grid = {
        pair: activeGrid.pair,
        lowerBound: Number(activeGrid.lowerBound),
        upperBound: Number(activeGrid.upperBound),
        gridStepPct: Number(activeGrid.gridStepPct),
        levelsCount: activeGrid.levelsCount,
        orders: [],
        active: true,
        gridStateId: activeGrid.id,
      };
      await this.reconcileWithExchange();
    }
  }

  // --- Grid lifecycle ---

  async setupGrid(
    pair: string,
    currentPrice: number,
    atr14: number,
    totalCapital: number,
  ): Promise<void> {
    if (this.grid?.active) {
      this.logger.warn('Grid already active, cancel first');
      return;
    }

    const params = calculateGridParams({
      currentPrice,
      atr14,
      capital: totalCapital,
    });

    const capitalPerLevel = calculateCapitalPerLevel(
      totalCapital,
      params.levelsCount,
    );

    const coreOrders = generateGridOrders(params, currentPrice, capitalPerLevel);

    const managedOrders: ManagedOrder[] = coreOrders.map((o) => ({
      ...o,
      gridCycleId: randomUUID(),
    }));

    // Save grid state to DB
    const gridState = await this.prisma.gridState.create({
      data: {
        pair,
        updatedAt: new Date(),
        lowerBound: params.lowerBound,
        upperBound: params.upperBound,
        gridStepPct: params.gridStepPct,
        levelsCount: params.levelsCount,
        capitalUsdt: totalCapital,
        active: true,
      },
    });

    this.grid = {
      pair,
      lowerBound: params.lowerBound,
      upperBound: params.upperBound,
      gridStepPct: params.gridStepPct,
      levelsCount: params.levelsCount,
      orders: managedOrders,
      active: true,
      gridStateId: gridState.id,
    };

    this.logger.log(
      `Grid setup: ${pair} [${params.lowerBound} - ${params.upperBound}] step=${params.gridStepPct}% levels=${params.levelsCount}`,
    );

    // Place all orders on exchange
    await this.placeAllPendingOrders();
  }

  async cancelGrid(): Promise<void> {
    if (!this.grid) return;

    this.grid.active = false;

    // Cancel all placed orders on exchange
    const placedOrders = this.grid.orders.filter(
      (o) => o.status === 'placed' && o.exchangeOrderId,
    );

    for (const order of placedOrders) {
      try {
        await withRetry(
          () =>
            this.exchange.cancelOrder(order.exchangeOrderId!, this.grid!.pair),
          {
            maxRetries: 3,
            delayMs: 1000,
            logger: this.logger,
            context: `cancelOrder:${order.exchangeOrderId}`,
          },
        );
        order.status = 'cancelled';
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Failed to cancel order ${order.exchangeOrderId}: ${msg}`,
        );
      }
    }

    // Update DB
    if (this.grid.gridStateId) {
      await this.prisma.gridState.update({
        where: { id: this.grid.gridStateId },
        data: { active: false, updatedAt: new Date() },
      });
    }

    this.logger.log(`Grid cancelled for ${this.grid.pair}`);
  }

  // --- Order placement ---

  private async placeAllPendingOrders(): Promise<void> {
    if (!this.grid?.active) return;

    const pending = this.grid.orders.filter((o) => o.status === 'pending');

    for (const order of pending) {
      await this.placeOrder(order);
    }

    this.logger.log(`Placed ${pending.length} orders on exchange`);
  }

  private async placeOrder(order: ManagedOrder): Promise<void> {
    if (!this.grid?.active) return;

    try {
      const result = await withRetry(
        () =>
          this.exchange.createOrder(
            this.grid!.pair,
            'limit',
            order.side,
            order.quantity,
            order.price,
          ),
        {
          maxRetries: 3,
          delayMs: 2000,
          logger: this.logger,
          context: `createOrder:${order.side}:${order.price}`,
        },
      );

      order.exchangeOrderId = result.id;
      order.status = 'placed';
      order.placedAt = new Date();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to place ${order.side} @ ${order.price}: ${msg}`,
      );
    }
  }

  // --- Order tracking (polling) ---

  @Interval(ORDER_POLL_MS)
  async pollOrderStatuses(): Promise<void> {
    if (!this.grid?.active || this.processingOrders) return;

    this.processingOrders = true;
    try {
      await this.checkAndProcessFills();
    } finally {
      this.processingOrders = false;
    }
  }

  private async checkAndProcessFills(): Promise<void> {
    if (!this.grid?.active) return;

    let exchangeOrders;
    try {
      exchangeOrders = await withRetry(
        () => this.exchange.fetchOpenOrders(this.grid!.pair),
        {
          maxRetries: 3,
          delayMs: 2000,
          logger: this.logger,
          context: 'fetchOpenOrders',
        },
      );
    } catch {
      return; // retry next cycle
    }

    const openIds = new Set(exchangeOrders.map((o) => o.id));

    // Find orders that were placed but are no longer open (= filled or cancelled by exchange)
    const potentiallyFilled = this.grid.orders.filter(
      (o) => o.status === 'placed' && o.exchangeOrderId && !openIds.has(o.exchangeOrderId),
    );

    for (const order of potentiallyFilled) {
      await this.handleFilledOrCancelled(order);
    }
  }

  private async handleFilledOrCancelled(order: ManagedOrder): Promise<void> {
    if (!this.grid?.active) return;

    // Check actual order status on exchange
    let exchangeOrder;
    try {
      exchangeOrder = await withRetry(
        () =>
          this.exchange.getExchange().fetchOrder(order.exchangeOrderId!, this.grid!.pair),
        {
          maxRetries: 2,
          delayMs: 1000,
          logger: this.logger,
          context: `fetchOrder:${order.exchangeOrderId}`,
        },
      );
    } catch {
      this.logger.warn(
        `Cannot fetch order ${order.exchangeOrderId}, will retry next cycle`,
      );
      return;
    }

    if (exchangeOrder.status === 'closed') {
      // Fully filled
      await this.onOrderFilled(order, exchangeOrder.filled);
    } else if (exchangeOrder.status === 'canceled' || exchangeOrder.status === 'cancelled') {
      // Cancelled by exchange (maintenance, etc.)
      this.logger.warn(
        `Order ${order.exchangeOrderId} cancelled by exchange, re-placing`,
      );
      order.status = 'pending';
      order.exchangeOrderId = undefined;
      await this.placeOrder(order);
    } else if (
      exchangeOrder.status === 'open' &&
      exchangeOrder.filled > 0 &&
      exchangeOrder.filled < order.quantity
    ) {
      // Partially filled — cancel remainder and treat filled portion as complete
      this.logger.log(
        `Order ${order.exchangeOrderId} partially filled: ${exchangeOrder.filled}/${order.quantity}, cancelling remainder`,
      );
      try {
        await this.exchange.cancelOrder(order.exchangeOrderId!, this.grid!.pair);
      } catch {
        this.logger.warn(`Could not cancel partial order ${order.exchangeOrderId}, will retry next cycle`);
        return;
      }
      await this.onOrderFilled(order, exchangeOrder.filled);
    }
  }

  private async onOrderFilled(
    order: ManagedOrder,
    filledQuantity: number,
  ): Promise<void> {
    if (!this.grid) return;

    order.status = 'filled';
    const actualQty = filledQuantity > 0 ? filledQuantity : order.quantity;
    const feeRate = 0.001; // 0.1%
    const feeUsdt = order.price * actualQty * feeRate;

    // Log trade to DB
    await this.prisma.trade.create({
      data: {
        pair: this.grid.pair,
        executedAt: new Date(),
        side: order.side,
        price: order.price,
        quantity: actualQty,
        feeUsdt,
        gridCycleId: order.gridCycleId,
        exchangeOrderId: order.exchangeOrderId,
      },
    });

    // Create counter-order (buy filled → place sell above, and vice versa)
    if (order.side === 'buy') {
      const sellLevel = onBuyFilled(order, this.grid.gridStepPct);
      const pnl = calculateCyclePnl(
        order.price,
        sellLevel.price,
        actualQty,
        feeRate,
      );

      const counterOrder: ManagedOrder = {
        levelIndex: order.levelIndex,
        price: sellLevel.price,
        side: 'sell',
        quantity: actualQty,
        status: 'pending',
        gridCycleId: order.gridCycleId,
      };

      this.grid.orders.push(counterOrder);
      await this.placeOrder(counterOrder);

      this.logger.log(
        `BUY filled @ ${order.price} → SELL placed @ ${sellLevel.price} (expected PnL: $${pnl.toFixed(2)})`,
      );
    } else {
      const buyLevel = onSellFilled(order, this.grid.gridStepPct);
      const pnl = calculateCyclePnl(
        buyLevel.price,
        order.price,
        actualQty,
        feeRate,
      );

      // Update trade with PnL
      if (order.exchangeOrderId) {
        await this.prisma.trade.updateMany({
          where: { exchangeOrderId: order.exchangeOrderId },
          data: { pnlUsdt: pnl },
        });
      }

      const counterOrder: ManagedOrder = {
        levelIndex: order.levelIndex,
        price: buyLevel.price,
        side: 'buy',
        quantity: actualQty,
        status: 'pending',
        gridCycleId: randomUUID(), // new cycle
      };

      this.grid.orders.push(counterOrder);
      await this.placeOrder(counterOrder);

      this.logger.log(
        `SELL filled @ ${order.price} → BUY placed @ ${buyLevel.price} (cycle PnL: $${pnl.toFixed(2)})`,
      );
    }

    // Log decision
    await this.prisma.decisionLog.create({
      data: {
        decidedAt: new Date(),
        trigger: 'order_filled',
        actionTaken: {
          filledSide: order.side,
          filledPrice: order.price,
          quantity: actualQty,
        },
      },
    });

    // Cleanup: remove filled orders to prevent memory growth
    this.grid.orders = this.grid.orders.filter(
      (o) => o.status !== 'filled' && o.status !== 'cancelled',
    );
  }

  // --- Startup reconciliation ---

  async reconcileWithExchange(): Promise<void> {
    if (!this.grid) {
      this.logger.log('No active grid, skipping reconciliation');
      return;
    }

    this.logger.log('Starting reconciliation with exchange...');

    let exchangeOrders;
    try {
      exchangeOrders = await withRetry(
        () => this.exchange.fetchOpenOrders(this.grid!.pair),
        {
          maxRetries: 3,
          delayMs: 2000,
          logger: this.logger,
          context: 'reconcile:fetchOpenOrders',
        },
      );
    } catch {
      this.logger.error('Reconciliation failed: cannot fetch exchange orders');
      return;
    }

    const exchangeIds = new Set(exchangeOrders.map((o) => o.id));
    let resynced = 0;

    for (const order of this.grid.orders) {
      if (order.status === 'placed' && order.exchangeOrderId) {
        if (!exchangeIds.has(order.exchangeOrderId)) {
          // Order no longer on exchange — was filled or cancelled while bot was down
          this.logger.warn(
            `Order ${order.exchangeOrderId} not found on exchange, marking for re-check`,
          );
          await this.handleFilledOrCancelled(order);
          resynced++;
        }
      }
    }

    // Check for orphan exchange orders (on exchange but not in our state)
    const ourExchangeIds = new Set(
      this.grid.orders
        .filter((o) => o.exchangeOrderId)
        .map((o) => o.exchangeOrderId),
    );

    for (const eo of exchangeOrders) {
      if (!ourExchangeIds.has(eo.id)) {
        this.logger.warn(
          `Orphan order on exchange: ${eo.id} ${eo.side} @ ${eo.price}, cancelling`,
        );
        try {
          await this.exchange.cancelOrder(eo.id, this.grid.pair);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          this.logger.error(`Failed to cancel orphan ${eo.id}: ${msg}`);
        }
      }
    }

    this.logger.log(
      `Reconciliation done: ${resynced} orders re-synced, ${exchangeOrders.length} on exchange`,
    );
  }

  // --- State queries ---

  getGrid(): ActiveGrid | null {
    return this.grid;
  }

  isActive(): boolean {
    return this.grid?.active ?? false;
  }

  isPriceInRange(price: number): boolean {
    if (!this.grid) return false;
    return isPriceInGrid(price, this.grid.lowerBound, this.grid.upperBound);
  }
}
