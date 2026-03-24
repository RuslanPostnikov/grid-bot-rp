import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ExchangeService } from '../exchange/exchange.service.js';
import { PrismaService } from '../../prisma.service.js';
import { withRetry } from '../../common/retry.js';
import { BOT_EVENTS, type OrderFilledPayload } from '../../common/events.js';
import {
  calculateGridParams,
  calculateCapitalPerLevel,
  calculateMaxLevels,
  generateGridOrders,
  onBuyFilled,
  onSellFilled,
  calculateCyclePnl,
  isPriceInGrid,
  checkRebalanceTriggers,
  calculateRebalance,
} from './grid-calculator.js';
import type { GridOrder, GridParams, RebalanceResult } from './grid.types.js';
import { ATR } from 'technicalindicators';
import { randomUUID } from 'node:crypto';

const ORDER_POLL_MS = 15_000; // check order status every 15s
const REBALANCE_CHECK_MS = 5 * 60 * 1000; // check rebalance every 5 min
const REBALANCE_COOLDOWN_MS = 30 * 60 * 1000; // 30 min between rebalances
const MIN_ORDER_NOTIONAL_USDT = 6;

export interface ActiveGrid {
  pair: string;
  lowerBound: number;
  upperBound: number;
  gridStepPct: number;
  levelsCount: number;
  orders: ManagedOrder[];
  active: boolean;
  gridStateId: bigint | null;
  feeRate: number;
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
  private cachedFeeRate = 0.001; // updated on setup/restore
  private upperZoneEnteredAt: number | null = null;
  private lowerZoneEnteredAt: number | null = null;
  private lastRebalanceAt = 0;

  constructor(
    private readonly exchange: ExchangeService,
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Restore active grid from DB on startup
    const activeGrid = await this.prisma.gridState.findFirst({
      where: { active: true },
      orderBy: { updatedAt: 'desc' },
      include: { orders: true },
    });

    if (activeGrid) {
      this.logger.log(
        `Restoring active grid for ${activeGrid.pair}, id=${activeGrid.id}`,
      );
      // Restore orders from DB
      const restoredOrders: ManagedOrder[] = activeGrid.orders
        .filter((o) => o.status === 'placed' || o.status === 'pending')
        .map((o) => ({
          levelIndex: o.levelIndex,
          side: o.side as 'buy' | 'sell',
          price: Number(o.price),
          quantity: Number(o.quantity),
          status: o.status as 'pending' | 'placed',
          exchangeOrderId: o.exchangeOrderId ?? undefined,
          gridCycleId: o.gridCycleId ?? randomUUID(),
          placedAt: o.placedAt ?? undefined,
        }));

      await this.fetchAndCacheFeeRate(activeGrid.pair);

      this.grid = {
        pair: activeGrid.pair,
        lowerBound: Number(activeGrid.lowerBound),
        upperBound: Number(activeGrid.upperBound),
        gridStepPct: Number(activeGrid.gridStepPct),
        levelsCount: activeGrid.levelsCount,
        orders: restoredOrders,
        active: true,
        gridStateId: activeGrid.id,
        feeRate: this.cachedFeeRate,
      };

      this.logger.log(
        `Restored ${restoredOrders.length} orders from DB (fee: ${(this.cachedFeeRate * 100).toFixed(3)}%)`,
      );
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

    await this.fetchAndCacheFeeRate(pair);

    const params = calculateGridParams({
      currentPrice,
      atr14,
      capital: totalCapital,
    });

    await this.initializeGrid(pair, params, totalCapital, currentPrice);
  }

  async setupGridWithParams(
    pair: string,
    currentPrice: number,
    totalCapital: number,
    lowerBound: number,
    upperBound: number,
    gridStepPct: number,
  ): Promise<void> {
    if (this.grid?.active) {
      this.logger.warn('Grid already active, cancel first');
      return;
    }

    await this.fetchAndCacheFeeRate(pair);

    const rangeSize = upperBound - lowerBound;
    const stepAbsolute = currentPrice * (gridStepPct / 100);
    let levelsCount = Math.floor(rangeSize / stepAbsolute);
    const capitalLimit = calculateMaxLevels(
      totalCapital,
      MIN_ORDER_NOTIONAL_USDT,
    );
    levelsCount = Math.max(2, Math.min(30, capitalLimit, levelsCount));

    const actualStep = rangeSize / levelsCount;
    const levels: number[] = [];
    for (let i = 0; i <= levelsCount; i++) {
      levels.push(Math.round((lowerBound + actualStep * i) * 100) / 100);
    }

    const params: GridParams = {
      lowerBound: Math.round(lowerBound * 100) / 100,
      upperBound: Math.round(upperBound * 100) / 100,
      gridStepPct: Math.round((actualStep / currentPrice) * 100 * 1000) / 1000,
      levelsCount,
      levels,
    };

    await this.initializeGrid(pair, params, totalCapital, currentPrice);
  }

  private async initializeGrid(
    pair: string,
    params: GridParams,
    totalCapital: number,
    currentPrice: number,
  ): Promise<void> {
    const capitalPerLevel = calculateCapitalPerLevel(
      totalCapital,
      params.levelsCount,
    );

    const coreOrders = generateGridOrders(
      params,
      currentPrice,
      capitalPerLevel,
    );

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
      feeRate: this.cachedFeeRate,
    };

    this.logger.log(
      `Grid setup: ${pair} [${params.lowerBound} - ${params.upperBound}] step=${params.gridStepPct}% levels=${params.levelsCount}`,
    );

    // Place all orders on exchange
    await this.placeAllPendingOrders();

    // Check for orphaned base asset from previous cycles
    await this.recoverOrphanedPosition(pair, currentPrice);
  }

  /**
   * If the account holds base asset (e.g. SOL) from a previous fill that wasn't
   * properly handled (crash, risk stop, redeploy), place a sell order for it.
   */
  private async recoverOrphanedPosition(
    pair: string,
    currentPrice: number,
  ): Promise<void> {
    if (!this.grid?.active) return;

    const baseAsset = pair.split('/')[0]; // 'SOL/USDT' → 'SOL'
    let freeBase = 0;
    try {
      const balance = await this.exchange.fetchBalance();
      const assetLower = baseAsset.toLowerCase();
      freeBase = Number(
        balance.free?.[baseAsset] ?? balance.free?.[assetLower] ?? 0,
      );
    } catch {
      return;
    }

    // Minimum notional check: qty * price >= $6
    const notional = freeBase * currentPrice;
    if (notional < 6) return;

    const sellPrice = currentPrice * (1 + this.grid.gridStepPct / 100);
    const roundedPrice = Math.round(sellPrice * 100) / 100;
    const roundedQty = Math.round(freeBase * 100000) / 100000;

    this.logger.log(
      `Orphaned ${baseAsset} detected: ${roundedQty} (~$${notional.toFixed(2)}). Placing sell @ $${roundedPrice}`,
    );

    const sellOrder: ManagedOrder = {
      levelIndex: 0,
      price: roundedPrice,
      side: 'sell',
      quantity: roundedQty,
      status: 'pending',
      gridCycleId: randomUUID(),
    };

    this.grid.orders.push(sellOrder);
    await this.placeOrder(sellOrder);
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
        // -2011 "Unknown order" = order was already filled or cancelled on exchange
        if (msg.includes('-2011') || msg.includes('Unknown order')) {
          this.logger.warn(
            `Order ${order.exchangeOrderId} not found on exchange, checking if filled...`,
          );
          try {
            const exOrder = await this.exchange
              .getExchange()
              .fetchOrder(order.exchangeOrderId!, this.grid.pair);
            if (exOrder.status === 'closed') {
              this.logger.log(
                `Order ${order.exchangeOrderId} was filled while cancelling! Processing fill...`,
              );
              // Temporarily re-enable grid to process the fill
              this.grid.active = true;
              await this.onOrderFilled(order, exOrder.filled);
              this.grid.active = false;
            } else {
              order.status = 'cancelled';
            }
          } catch {
            this.logger.error(
              `Could not check order ${order.exchangeOrderId} status`,
            );
          }
        } else {
          this.logger.error(
            `Failed to cancel order ${order.exchangeOrderId}: ${msg}`,
          );
        }
      }
    }

    // Update DB: mark grid inactive and all orders cancelled
    if (this.grid.gridStateId) {
      await this.prisma.gridState.update({
        where: { id: this.grid.gridStateId },
        data: { active: false, updatedAt: new Date() },
      });
      await this.prisma.gridOrder.updateMany({
        where: {
          gridStateId: this.grid.gridStateId,
          status: { in: ['placed', 'pending'] },
        },
        data: { status: 'cancelled' },
      });
    }

    this.logger.log(`Grid cancelled for ${this.grid.pair}`);
  }

  // --- Order placement ---

  private async placeAllPendingOrders(): Promise<void> {
    if (!this.grid?.active) return;

    // Place only buy orders on initial setup — sell orders are created dynamically via onBuyFilled
    const pending = this.grid.orders.filter(
      (o) => o.status === 'pending' && o.side === 'buy',
    );

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

      // Save order to DB
      await this.saveOrderToDb(order);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to place ${order.side} @ ${order.price}: ${msg}`,
      );
    }
  }

  private async saveOrderToDb(order: ManagedOrder): Promise<void> {
    if (!this.grid?.gridStateId) return;
    try {
      // Upsert: update if exists (by exchangeOrderId), create otherwise
      if (order.exchangeOrderId) {
        const existing = await this.prisma.gridOrder.findFirst({
          where: {
            gridStateId: this.grid.gridStateId,
            exchangeOrderId: order.exchangeOrderId,
          },
        });
        if (existing) {
          await this.prisma.gridOrder.update({
            where: { id: existing.id },
            data: {
              status: order.status,
              placedAt: order.placedAt,
            },
          });
          return;
        }
      }
      await this.prisma.gridOrder.create({
        data: {
          gridStateId: this.grid.gridStateId,
          levelIndex: order.levelIndex,
          side: order.side,
          price: order.price,
          quantity: order.quantity,
          status: order.status,
          exchangeOrderId: order.exchangeOrderId,
          gridCycleId: order.gridCycleId,
          placedAt: order.placedAt,
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`Failed to save order to DB: ${msg}`);
    }
  }

  private async updateOrderStatusInDb(
    exchangeOrderId: string,
    status: string,
  ): Promise<void> {
    try {
      await this.prisma.gridOrder.updateMany({
        where: { exchangeOrderId },
        data: { status },
      });
    } catch {
      // non-critical
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
      (o) =>
        o.status === 'placed' &&
        o.exchangeOrderId &&
        !openIds.has(o.exchangeOrderId),
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
          this.exchange
            .getExchange()
            .fetchOrder(order.exchangeOrderId!, this.grid!.pair),
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
    } else if (
      exchangeOrder.status === 'canceled' ||
      exchangeOrder.status === 'cancelled'
    ) {
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
        await this.exchange.cancelOrder(order.exchangeOrderId!, this.grid.pair);
      } catch {
        this.logger.warn(
          `Could not cancel partial order ${order.exchangeOrderId}, will retry next cycle`,
        );
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
    const feeRate = this.grid.feeRate;
    const feeUsdt = order.price * actualQty * feeRate;

    // Update order status in DB
    if (order.exchangeOrderId) {
      await this.updateOrderStatusInDb(order.exchangeOrderId, 'filled');
    }

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

      this.eventEmitter.emit(BOT_EVENTS.ORDER_FILLED, {
        side: 'buy',
        price: order.price,
        quantity: actualQty,
        counterPrice: sellLevel.price,
        expectedPnl: pnl,
      } satisfies OrderFilledPayload);

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

      this.eventEmitter.emit(BOT_EVENTS.ORDER_FILLED, {
        side: 'sell',
        price: order.price,
        quantity: actualQty,
        counterPrice: buyLevel.price,
        expectedPnl: pnl,
      } satisfies OrderFilledPayload);

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

  // --- Rebalancing ---

  async rebalanceGrid(
    currentPrice: number,
    result: RebalanceResult,
  ): Promise<void> {
    if (!this.grid) return;

    const pair = this.grid.pair;

    // Get current capital (USDT + crypto value)
    let totalCapital: number;
    try {
      const balance = await this.exchange.fetchBalance();
      const freeUsdt = Number(balance.free?.USDT ?? balance.free?.usdt ?? 0);
      const usedUsdt = Number(balance.used?.USDT ?? balance.used?.usdt ?? 0);
      const usdtTotal = freeUsdt + usedUsdt;

      // Include crypto value to avoid losing capital in open positions
      const asset = pair.split('/')[0];
      const assetKey = asset.toUpperCase();
      const assetBalance =
        Number(balance.free?.[assetKey] ?? 0) +
        Number(balance.used?.[assetKey] ?? 0);
      const cryptoValue = assetBalance * currentPrice;

      const grossCapital = usdtTotal + cryptoValue;
      const activeCapitalPct =
        this.config.get<number>('risk.activeCapitalPct') ?? 90;
      totalCapital = grossCapital * (activeCapitalPct / 100);
    } catch {
      this.logger.error('Rebalance failed: cannot fetch balance');
      return;
    }

    if (totalCapital <= 0) {
      this.logger.error('Rebalance failed: no capital');
      return;
    }

    this.logger.log(
      `Rebalancing: ${result.trigger} → [${result.newLowerBound} - ${result.newUpperBound}] step=${result.newGridStepPct}%`,
    );

    await this.cancelGrid();
    await this.setupGridWithParams(
      pair,
      currentPrice,
      totalCapital,
      result.newLowerBound,
      result.newUpperBound,
      result.newGridStepPct,
    );

    this.upperZoneEnteredAt = null;
    this.lowerZoneEnteredAt = null;
    this.lastRebalanceAt = Date.now();

    await this.prisma.decisionLog.create({
      data: {
        decidedAt: new Date(),
        trigger: `rebalance:${result.trigger}`,
        actionTaken: {
          trigger: result.trigger,
          newLower: result.newLowerBound,
          newUpper: result.newUpperBound,
          newStep: result.newGridStepPct,
        },
      },
    });
  }

  @Interval(REBALANCE_CHECK_MS)
  async checkRebalance(): Promise<void> {
    if (!this.grid?.active) return;

    // Cooldown
    if (Date.now() - this.lastRebalanceAt < REBALANCE_COOLDOWN_MS) return;

    let currentPrice: number;
    try {
      const ticker = await this.exchange.fetchTicker(this.grid.pair);
      currentPrice = ticker.last ?? 0;
      if (!currentPrice) return;
    } catch {
      return;
    }

    const { lowerBound, upperBound } = this.grid;
    const range = upperBound - lowerBound;
    const upperZoneThreshold = upperBound - range * 0.2;
    const lowerZoneThreshold = lowerBound + range * 0.2;
    const now = Date.now();

    // Track zone time
    if (currentPrice > upperZoneThreshold) {
      if (!this.upperZoneEnteredAt) this.upperZoneEnteredAt = now;
    } else {
      this.upperZoneEnteredAt = null;
    }

    if (currentPrice < lowerZoneThreshold) {
      if (!this.lowerZoneEnteredAt) this.lowerZoneEnteredAt = now;
    } else {
      this.lowerZoneEnteredAt = null;
    }

    const hoursInUpper = this.upperZoneEnteredAt
      ? (now - this.upperZoneEnteredAt) / 3_600_000
      : 0;
    const hoursInLower = this.lowerZoneEnteredAt
      ? (now - this.lowerZoneEnteredAt) / 3_600_000
      : 0;

    // Fetch ATR data
    let atr14: number;
    let avgAtrPct: number;
    try {
      const candles = await this.exchange.fetchOHLCV(
        this.grid.pair,
        '1h',
        undefined,
        100,
      );
      if (candles.length < 15) return;

      const highs = candles.map((c) => c[2]);
      const lows = candles.map((c) => c[3]);
      const closes = candles.map((c) => c[4]);

      const atrValues = ATR.calculate({
        high: highs,
        low: lows,
        close: closes,
        period: 14,
      });
      atr14 = atrValues[atrValues.length - 1];
      if (!atr14) return;

      // Average ATR% over last 14 values
      const atrPctValues = atrValues.slice(-14).map((v, i) => {
        const idx = closes.length - 14 + i;
        return (v / closes[idx]) * 100;
      });
      avgAtrPct = atrPctValues.reduce((s, v) => s + v, 0) / atrPctValues.length;
    } catch {
      return;
    }

    const currentAtrPct = (atr14 / currentPrice) * 100;

    const trigger = checkRebalanceTriggers(
      currentPrice,
      lowerBound,
      upperBound,
      currentAtrPct,
      avgAtrPct,
      hoursInUpper,
      hoursInLower,
    );

    if (!trigger) return;

    const result = calculateRebalance(
      trigger,
      currentPrice,
      atr14,
      this.grid.gridStepPct,
      avgAtrPct,
    );

    await this.rebalanceGrid(currentPrice, result);
  }

  // --- Fee rate ---

  private async fetchAndCacheFeeRate(pair: string): Promise<void> {
    try {
      const fees = await this.exchange.fetchTradingFee(pair);
      this.cachedFeeRate = fees.taker;
      this.logger.log(`Fee rate: ${(this.cachedFeeRate * 100).toFixed(3)}%`);
    } catch {
      this.logger.warn('Could not fetch trading fee, using default 0.1%');
    }
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
