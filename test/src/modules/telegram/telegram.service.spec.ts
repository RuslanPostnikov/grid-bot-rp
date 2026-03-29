type Ctx = {
  from?: { username?: string; id?: number };
  reply: jest.Mock;
  editMessageReplyMarkup: jest.Mock;
  match?: RegExpMatchArray;
};

const commandHandlers = new Map<string, (ctx: Ctx) => unknown>();
const actionHandlers: Array<{
  pattern: string | RegExp;
  fn: (ctx: Ctx) => unknown;
}> = [];
let storedMiddleware:
  | ((ctx: Ctx, next: () => Promise<void>) => Promise<unknown>)
  | undefined;

jest.mock('telegraf', () => ({
  Telegraf: jest.fn().mockImplementation(() => ({
    use: jest.fn(
      (mw: (ctx: Ctx, next: () => Promise<void>) => Promise<unknown>) => {
        storedMiddleware = mw;
      },
    ),
    command: jest.fn((name: string, fn: (ctx: Ctx) => unknown) => {
      commandHandlers.set(name, fn);
    }),
    action: jest.fn((re: string | RegExp, fn: (ctx: Ctx) => unknown) => {
      actionHandlers.push({ pattern: re, fn });
    }),
    launch: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn(),
    telegram: { sendMessage: jest.fn().mockResolvedValue({}) },
  })),
  Markup: {
    inlineKeyboard: jest.fn((rows: unknown) => ({ inline_keyboard: rows })),
    button: {
      callback: (text: string, data: string) => ({ text, callback_data: data }),
    },
  },
}));

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TelegramService } from '@src/modules/telegram/telegram.service.js';
import { ExchangeService } from '@src/modules/exchange/exchange.service.js';
import { GridService } from '@src/modules/grid/grid.service.js';
import { RiskService } from '@src/modules/risk/risk.service.js';
import { ClaudeService } from '@src/modules/claude/claude.service.js';
import { PrismaService } from '@src/prisma.service.js';
import {
  type RiskEventPayload,
  type RegimeChangePayload,
  type ClaudeAdvicePendingPayload,
  type OrderFilledPayload,
} from '@src/common/events.js';

describe('TelegramService', () => {
  let service: TelegramService;
  let exchange: { fetchTicker: jest.Mock };
  let grid: Record<string, jest.Mock>;
  let risk: Record<string, jest.Mock>;
  let claude: { getLatestAdvice: jest.Mock; applyPendingAdvice: jest.Mock };
  let prisma: {
    trade: { findMany: jest.Mock };
    decisionLog: { create: jest.Mock };
  };
  let emit: jest.Mock;
  async function createModule(token: string, chatId: string, users: string[]) {
    commandHandlers.clear();
    actionHandlers.length = 0;
    storedMiddleware = undefined;

    exchange = {
      fetchTicker: jest.fn().mockResolvedValue({ last: 100 }),
    };
    grid = {
      getBaseAssetSellInfo: jest.fn().mockResolvedValue({
        baseAsset: 'SOL',
        freeBase: 0,
        roundedQty: 0,
        price: 100,
        notional: 0,
      }),
      marketSellBase: jest
        .fn()
        .mockResolvedValue({ filledQty: 1, filledPrice: 100, totalUsdt: 100 }),
      isActive: jest.fn().mockReturnValue(false),
      getGrid: jest.fn().mockReturnValue(null),
      cancelGrid: jest.fn().mockResolvedValue(undefined),
    };
    risk = {
      isPaused: jest.fn().mockReturnValue(false),
      pause: jest.fn(),
      resume: jest.fn(),
      getCurrentRiskSnapshot: jest.fn().mockReturnValue({
        level: 'normal',
        dailyDrawdownPct: 0,
        weeklyDrawdownPct: 0,
      }),
      getBalanceSnapshot: jest.fn().mockReturnValue({
        freeUsdt: 10,
        usedUsdt: 0,
        totalUsdt: 10,
        freeBase: 0,
        usedBase: 0,
        totalBase: 0,
        baseAsset: 'SOL',
        price: 100,
      }),
    };
    claude = {
      getLatestAdvice: jest.fn().mockResolvedValue(null),
      applyPendingAdvice: jest.fn().mockResolvedValue(true),
    };
    prisma = {
      trade: { findMany: jest.fn().mockResolvedValue([]) },
      decisionLog: { create: jest.fn().mockResolvedValue({}) },
    };
    emit = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TelegramService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((k: string) => {
              if (k === 'telegram.botToken') return token;
              if (k === 'telegram.chatId') return chatId;
              if (k === 'telegram.allowedUsers') return users;
              if (k === 'exchange.tradingPair') return 'SOL/USDT';
              return undefined;
            }),
          },
        },
        { provide: ExchangeService, useValue: exchange },
        { provide: GridService, useValue: grid },
        { provide: RiskService, useValue: risk },
        { provide: ClaudeService, useValue: claude },
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: { emit } },
      ],
    }).compile();

    return module.get(TelegramService);
  }

  async function withAuth(
    fn: (ctx: Ctx) => unknown,
    ctxOverrides: Partial<Ctx> = {},
  ) {
    const ctx: Ctx = {
      from: { username: 'alice', id: 1 },
      reply: jest.fn().mockResolvedValue(undefined),
      editMessageReplyMarkup: jest.fn().mockResolvedValue(undefined),
      ...ctxOverrides,
    };
    const next = async () => {
      await fn(ctx);
    };
    expect(storedMiddleware).toBeDefined();
    await storedMiddleware!(ctx, next);
    return ctx;
  }

  beforeEach(() => {
    jest.useRealTimers();
  });

  it('skips bot when token missing', async () => {
    service = await createModule('', '1', ['alice']);
    service.onModuleInit();
    expect(commandHandlers.size).toBe(0);
  });

  it('registerCommands no-op when bot not created', async () => {
    service = await createModule('', '1', ['alice']);
    (service as unknown as { registerCommands: () => void }).registerCommands();
    expect(commandHandlers.size).toBe(0);
  });

  it('registerCallbacks no-op when bot not created', async () => {
    service = await createModule('', '1', ['alice']);
    (
      service as unknown as { registerCallbacks: () => void }
    ).registerCallbacks();
    expect(actionHandlers.length).toBe(0);
  });

  it('uses config fallbacks for chatId and trading pair', async () => {
    commandHandlers.clear();
    const ex = { fetchTicker: jest.fn() };
    const gr = {
      getBaseAssetSellInfo: jest.fn(),
      marketSellBase: jest.fn(),
      isActive: jest.fn(),
      getGrid: jest.fn(),
      cancelGrid: jest.fn(),
    };
    const rk = {
      isPaused: jest.fn(),
      pause: jest.fn(),
      resume: jest.fn(),
      getCurrentRiskSnapshot: jest.fn(),
      getBalanceSnapshot: jest.fn(),
    };
    const cl = { getLatestAdvice: jest.fn(), applyPendingAdvice: jest.fn() };
    const pr = {
      trade: { findMany: jest.fn() },
      decisionLog: { create: jest.fn() },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TelegramService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((k: string) => {
              if (k === 'telegram.botToken') return 'tok';
              if (k === 'telegram.chatId') return undefined;
              if (k === 'telegram.allowedUsers') return ['bob'];
              if (k === 'exchange.tradingPair') return undefined;
              return undefined;
            }),
          },
        },
        { provide: ExchangeService, useValue: ex },
        { provide: GridService, useValue: gr },
        { provide: RiskService, useValue: rk },
        { provide: ClaudeService, useValue: cl },
        { provide: PrismaService, useValue: pr },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();
    const s = module.get(TelegramService);
    expect((s as unknown as { tradingPair: string }).tradingPair).toBe(
      'BTC/USDT',
    );
    expect((s as unknown as { chatId: string }).chatId).toBe('');
  });

  it('starts bot and registers commands when token set', async () => {
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    expect(commandHandlers.has('start')).toBe(true);
    expect(commandHandlers.has('status')).toBe(true);
    service.onModuleDestroy();
  });

  it('logs when bot.launch fails', async () => {
    const telegrafMod = jest.requireMock('telegraf') as unknown as {
      Telegraf: jest.Mock;
    };
    const TelegrafCtor: jest.Mock = telegrafMod.Telegraf;
    TelegrafCtor.mockImplementationOnce(() => ({
      use: jest.fn(),
      command: jest.fn(),
      action: jest.fn(),
      launch: jest.fn().mockRejectedValue(new Error('launch-fail')),
      stop: jest.fn(),
      telegram: { sendMessage: jest.fn() },
    }));
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    await Promise.resolve();
  });

  it('middleware denies unknown user', async () => {
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    const ctx: Ctx = {
      from: { username: 'hacker', id: 2 },
      reply: jest.fn().mockResolvedValue(undefined),
      editMessageReplyMarkup: jest.fn(),
    };
    await storedMiddleware!(ctx, () => {
      throw new Error('next should not run');
    });
    expect(ctx.reply).toHaveBeenCalled();
  });

  it('middleware denies when username missing', async () => {
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    const ctx: Ctx = {
      from: { id: 99 },
      reply: jest.fn().mockResolvedValue(undefined),
      editMessageReplyMarkup: jest.fn(),
    };
    await storedMiddleware!(ctx, () => {
      throw new Error('next should not run');
    });
    expect(ctx.reply).toHaveBeenCalled();
  });

  it('onModuleInit launch failure stringifies non-Error', async () => {
    const telegrafMod = jest.requireMock('telegraf') as unknown as {
      Telegraf: jest.Mock;
    };
    const TelegrafCtor: jest.Mock = telegrafMod.Telegraf;
    TelegrafCtor.mockImplementationOnce(() => ({
      use: jest.fn(),
      command: jest.fn(),
      action: jest.fn(),
      launch: jest.fn().mockRejectedValue('plain-launch'),
      stop: jest.fn(),
      telegram: { sendMessage: jest.fn() },
    }));
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    await Promise.resolve();
  });

  it('runs /start for allowed user', async () => {
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    await withAuth((ctx) => commandHandlers.get('start')!(ctx));
  });

  it('runs /status with active grid and orders', async () => {
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    grid.getGrid.mockReturnValue({
      pair: 'SOL/USDT',
      active: true,
      lowerBound: 90,
      upperBound: 110,
      gridStepPct: 1,
      orders: [
        { status: 'placed', side: 'buy', price: 95 },
        { status: 'placed', side: 'sell', price: 105 },
      ],
    });
    await withAuth((ctx) => commandHandlers.get('status')!(ctx));
  });

  it('runs /status when ticker fails', async () => {
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    exchange.fetchTicker.mockRejectedValueOnce(new Error('e'));
    await withAuth((ctx) => commandHandlers.get('status')!(ctx));
  });

  it('runs /status catch when buildStatus throws', async () => {
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    grid.getGrid.mockImplementation(() => {
      throw new Error('snap');
    });
    await withAuth((ctx) => commandHandlers.get('status')!(ctx));
    grid.getGrid.mockReturnValue(null);
  });

  it('runs /pnl catch on prisma error', async () => {
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    prisma.trade.findMany.mockRejectedValueOnce(new Error('db'));
    await withAuth((ctx) => commandHandlers.get('pnl')!(ctx));
  });

  it('runs /sell catch when getBaseAssetSellInfo throws', async () => {
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    grid.getBaseAssetSellInfo.mockRejectedValueOnce(new Error('x'));
    await withAuth((ctx) => commandHandlers.get('sell')!(ctx));
  });

  it('runs /pnl with trades', async () => {
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    prisma.trade.findMany.mockResolvedValue([
      { pnlUsdt: 1, feeUsdt: 0.1, executedAt: new Date() },
    ]);
    await withAuth((ctx) => commandHandlers.get('pnl')!(ctx));
  });

  it('buildPnlMessage uses nullish coalesce for pnl and fee fields', async () => {
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    prisma.trade.findMany.mockResolvedValue([
      { pnlUsdt: null, feeUsdt: null, executedAt: new Date() },
    ]);
    const msg = await (
      service as unknown as { buildPnlMessage: () => Promise<string> }
    ).buildPnlMessage();
    expect(msg).toContain('PnL Report');
    expect(msg).toMatch(/Win rate: 0%/);
  });

  it('runs /pause and /resume paths', async () => {
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    risk.isPaused.mockReturnValue(true);
    grid.isActive.mockReturnValue(false);
    await withAuth((ctx) => commandHandlers.get('pause')!(ctx));
    risk.isPaused.mockReturnValue(false);
    grid.isActive.mockReturnValue(true);
    await withAuth((ctx) => commandHandlers.get('resume')!(ctx));
  });

  it('runs /pause cancelling active grid', async () => {
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    risk.isPaused.mockReturnValue(false);
    grid.isActive.mockReturnValue(true);
    await withAuth((ctx) => commandHandlers.get('pause')!(ctx));
    expect(grid.cancelGrid).toHaveBeenCalled();
  });

  it('runs /pause without cancel when grid inactive', async () => {
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    risk.isPaused.mockReturnValue(false);
    grid.isActive.mockReturnValue(false);
    grid.cancelGrid.mockClear();
    await withAuth((ctx) => commandHandlers.get('pause')!(ctx));
    expect(grid.cancelGrid).not.toHaveBeenCalled();
  });

  it('runs /resume early when already running', async () => {
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    risk.isPaused.mockReturnValue(false);
    grid.isActive.mockReturnValue(true);
    await withAuth((ctx) => commandHandlers.get('resume')!(ctx));
  });

  it('runs /resume when paused to emit BOT_RESUMED', async () => {
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    risk.isPaused.mockReturnValue(true);
    grid.isActive.mockReturnValue(false);
    await withAuth((ctx) => commandHandlers.get('resume')!(ctx));
    expect(risk.resume).toHaveBeenCalled();
    expect(emit).toHaveBeenCalled();
  });

  it('runs /advice when no saved advice', async () => {
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    claude.getLatestAdvice.mockResolvedValueOnce(null);
    await withAuth((ctx) => commandHandlers.get('advice')!(ctx));
  });

  it('runs /sell with sellable balance and inline keyboard', async () => {
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    grid.getBaseAssetSellInfo.mockResolvedValueOnce({
      baseAsset: 'SOL',
      freeBase: 0.5,
      roundedQty: 0.5,
      price: 100,
      notional: 50,
    });
    await withAuth((ctx) => commandHandlers.get('sell')!(ctx));
  });

  it('runs /advice when latest exists', async () => {
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    claude.getLatestAdvice.mockResolvedValue({
      trigger: 't',
      advice: {
        market_assessment: 'm',
        grid_recommendation: { action: 'keep', reason: 'r' },
        confidence: 0.8,
        risk_flags: ['x'],
        next_review_hours: 4,
      },
    });
    await withAuth((ctx) => commandHandlers.get('advice')!(ctx));
  });

  it('runs /sell preview and low balance', async () => {
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    await withAuth((ctx) => commandHandlers.get('sell')!(ctx));
  });

  it('callback apply_advice and reject', async () => {
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    const apply = actionHandlers.find(
      (h) =>
        typeof h.pattern !== 'string' &&
        h.pattern.source.includes('apply_advice'),
    );
    await apply!.fn({
      from: { username: 'alice' },
      match: ['apply_advice:1', '1'],
      reply: jest.fn(),
      editMessageReplyMarkup: jest.fn(),
    } as Ctx);
    claude.applyPendingAdvice.mockResolvedValueOnce(false);
    await apply!.fn({
      from: { username: 'alice' },
      match: ['apply_advice:2', '2'],
      reply: jest.fn(),
      editMessageReplyMarkup: jest.fn(),
    } as Ctx);
    const reject = actionHandlers.find(
      (h) =>
        typeof h.pattern !== 'string' &&
        h.pattern.source.includes('reject_advice'),
    );
    await reject!.fn({
      reply: jest.fn(),
      editMessageReplyMarkup: jest.fn(),
    } as Ctx);
  });

  it('callback confirm_sell and cancel', async () => {
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    const confirm = actionHandlers.find(
      (h) =>
        typeof h.pattern !== 'string' &&
        h.pattern.source.includes('confirm_sell'),
    );
    await confirm!.fn({
      match: ['confirm_sell:0.1', '0.1'],
      reply: jest.fn(),
      editMessageReplyMarkup: jest.fn(),
    } as Ctx);
    prisma.decisionLog.create.mockRejectedValueOnce(new Error('log'));
    await confirm!.fn({
      match: ['confirm_sell:0.2', '0.2'],
      reply: jest.fn(),
      editMessageReplyMarkup: jest.fn(),
    } as Ctx);
    await confirm!.fn({
      match: ['confirm_sell:bad', 'oops'],
      reply: jest.fn(),
      editMessageReplyMarkup: jest.fn(),
    } as Ctx);
    grid.marketSellBase.mockRejectedValueOnce('sell-fail');
    await confirm!.fn({
      match: ['confirm_sell:0.3', '0.3'],
      reply: jest.fn(),
      editMessageReplyMarkup: jest.fn(),
    } as Ctx);
    const cancel = actionHandlers.find((h) => h.pattern === 'cancel_sell');
    await cancel!.fn({
      reply: jest.fn(),
      editMessageReplyMarkup: jest.fn(),
    } as Ctx);
  });

  it('event handlers call sendMessage', async () => {
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    const p: RiskEventPayload = {
      level: 'warning',
      reasons: ['a'],
      dailyDrawdownPct: 1,
      weeklyDrawdownPct: 2,
    };
    await service.onRiskWarning(p);
    await service.onRiskPause(p);
    await service.onStopLoss({
      currentPrice: 1,
      stopLossPrice: 2,
      lowerBound: 3,
      pair: 'SOL/USDT',
    });
    await service.onBotResumed();
    await service.onPriceOutOfRange({ priceDeviationPct: 5, currentPrice: 10 });
    const rc: RegimeChangePayload = {
      pair: 'SOL/USDT',
      oldRegime: 'a',
      newRegime: 'b',
      confidence: 0.5,
      action: 'RUN_GRID',
    };
    await service.onRegimeChange(rc);
    const cap: ClaudeAdvicePendingPayload = {
      adviceId: BigInt(1),
      assessment: 'x',
      action: 'adjust',
      reason: 'r',
      confidence: 0.8,
    };
    await service.onClaudeAdvicePending(cap);
    const of: OrderFilledPayload = {
      side: 'buy',
      price: 1,
      quantity: 0.1,
      counterPrice: 2,
      expectedPnl: 0.5,
    };
    await service.onOrderFilled(of);
    await service.onOrderFilled({ ...of, side: 'sell' });
  });

  it('sendMessage no-op without chatId', async () => {
    service = await createModule('tok', '', ['alice']);
    service.onModuleInit();
    await service.sendMessage('hi');
  });

  it('sendMessage catches telegram errors', async () => {
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    const bot = (
      service as unknown as { bot: { telegram: { sendMessage: jest.Mock } } }
    ).bot;
    bot.telegram.sendMessage.mockRejectedValueOnce(new Error('tg'));
    await service.sendMessage('x');
  });

  it('heartbeat and health', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    service.heartbeat();
    expect(service.getLastHeartbeat()).toBe(Date.now());
    expect(service.isHealthy()).toBe(true);
    jest.setSystemTime(new Date('2026-01-01T12:25:00Z'));
    expect(service.isHealthy()).toBe(false);
    jest.useRealTimers();
  });

  it('dailyReport runs', async () => {
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    await service.dailyReport();
  });

  it('constructs with direct DI args', () => {
    const cfg = { get: jest.fn() } as unknown as ConfigService;
    const ex = {} as ExchangeService;
    const gr = {} as GridService;
    const rk = {} as RiskService;
    const cl = {} as ClaudeService;
    const pr = {} as PrismaService;
    const ee = { emit: jest.fn() } as unknown as EventEmitter2;
    expect(new TelegramService(cfg, ex, gr, rk, cl, pr, ee)).toBeInstanceOf(
      TelegramService,
    );
  });

  it('sendAdviceForConfirmation', async () => {
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    await service.sendAdviceForConfirmation(BigInt(1), 'a', 'keep', 'r', 0.9);
  });

  it('uses empty allowedUsers when config omits array', async () => {
    commandHandlers.clear();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TelegramService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((k: string) => {
              if (k === 'telegram.botToken') return 'tok';
              if (k === 'telegram.chatId') return '1';
              if (k === 'telegram.allowedUsers') return undefined;
              if (k === 'exchange.tradingPair') return 'SOL/USDT';
              return undefined;
            }),
          },
        },
        { provide: ExchangeService, useValue: { fetchTicker: jest.fn() } },
        {
          provide: GridService,
          useValue: {
            getBaseAssetSellInfo: jest.fn(),
            marketSellBase: jest.fn(),
            isActive: jest.fn(),
            getGrid: jest.fn(),
            cancelGrid: jest.fn(),
          },
        },
        {
          provide: RiskService,
          useValue: {
            isPaused: jest.fn(),
            pause: jest.fn(),
            resume: jest.fn(),
            getCurrentRiskSnapshot: jest.fn(),
            getBalanceSnapshot: jest.fn(),
          },
        },
        {
          provide: ClaudeService,
          useValue: {
            getLatestAdvice: jest.fn(),
            applyPendingAdvice: jest.fn(),
          },
        },
        {
          provide: PrismaService,
          useValue: {
            trade: { findMany: jest.fn() },
            decisionLog: { create: jest.fn() },
          },
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();
    const s = module.get(TelegramService);
    expect((s as unknown as { allowedUsers: string[] }).allowedUsers).toEqual(
      [],
    );
  });

  it('/status active grid with buy orders only', async () => {
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    grid.getGrid.mockReturnValue({
      pair: 'SOL/USDT',
      active: true,
      lowerBound: 90,
      upperBound: 110,
      gridStepPct: 1,
      orders: [{ status: 'placed', side: 'buy', price: 95 }],
    });
    await withAuth((ctx) => commandHandlers.get('status')!(ctx));
  });

  it('/status active grid with sell orders only', async () => {
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    grid.getGrid.mockReturnValue({
      pair: 'SOL/USDT',
      active: true,
      lowerBound: 90,
      upperBound: 110,
      gridStepPct: 1,
      orders: [{ status: 'placed', side: 'sell', price: 105 }],
    });
    await withAuth((ctx) => commandHandlers.get('status')!(ctx));
  });

  it('/status uses N/A price when ticker last missing', async () => {
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    exchange.fetchTicker.mockResolvedValueOnce({ last: undefined });
    await withAuth((ctx) => commandHandlers.get('status')!(ctx));
  });

  it('/pnl with null pnl and profitable cycles for win rate', async () => {
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    const t = new Date();
    const rows = [
      { pnlUsdt: null, feeUsdt: 0.05, executedAt: t },
      { pnlUsdt: 2, feeUsdt: 0.1, executedAt: t },
      { pnlUsdt: -1, feeUsdt: 0.1, executedAt: t },
    ];
    prisma.trade.findMany.mockResolvedValue(rows);
    await withAuth((ctx) => commandHandlers.get('pnl')!(ctx));
  });

  it('sendMessage stringifies non-Error from telegram', async () => {
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    const bot = (
      service as unknown as { bot: { telegram: { sendMessage: jest.Mock } } }
    ).bot;
    bot.telegram.sendMessage.mockRejectedValueOnce('tg-fail');
    await service.sendMessage('x');
  });

  it('/advice without risk_flags line', async () => {
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    claude.getLatestAdvice.mockResolvedValue({
      trigger: 't',
      advice: {
        market_assessment: 'm',
        grid_recommendation: { action: 'keep', reason: 'r' },
        confidence: 0.5,
        risk_flags: [],
        next_review_hours: 2,
      },
    });
    await withAuth((ctx) => commandHandlers.get('advice')!(ctx));
  });

  it('middleware invokes next for allowed user', async () => {
    service = await createModule('tok', '99', ['alice']);
    service.onModuleInit();
    const next = jest.fn().mockResolvedValue(undefined);
    const ctx: Ctx = {
      from: { username: 'alice', id: 1 },
      reply: jest.fn().mockResolvedValue(undefined),
      editMessageReplyMarkup: jest.fn(),
    };
    await storedMiddleware!(ctx, next);
    expect(next).toHaveBeenCalled();
  });
});
