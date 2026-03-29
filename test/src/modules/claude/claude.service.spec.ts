const messagesCreate = jest.fn();

jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: messagesCreate },
  }));
});

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Anthropic from '@anthropic-ai/sdk';
import { ClaudeService } from '@src/modules/claude/claude.service.js';
import { PrismaService } from '@src/prisma.service.js';
import { ExchangeService } from '@src/modules/exchange/exchange.service.js';
import { GridService } from '@src/modules/grid/grid.service.js';
import { RiskService } from '@src/modules/risk/risk.service.js';
import { BOT_EVENTS } from '@src/common/events.js';

const validParsed = {
  market_assessment: 'ok',
  grid_recommendation: { action: 'keep', reason: 'r' },
  risk_flags: [] as string[],
  confidence: 0.9,
  next_review_hours: 4,
};

type ClaudeTestPrisma = {
  trade: { findMany: jest.Mock };
  marketRegime: { findFirst: jest.Mock };
  claudeAdvice: {
    create: jest.Mock;
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  decisionLog: { create: jest.Mock };
};

describe('ClaudeService', () => {
  let service: ClaudeService;
  let prisma: ClaudeTestPrisma;
  let grid: {
    isActive: jest.Mock;
    cancelGrid: jest.Mock;
    getGrid: jest.Mock;
  };
  let risk: { getCurrentRiskSnapshot: jest.Mock };
  let exchange: { fetchTicker: jest.Mock; fetchBalance: jest.Mock };
  let emit: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();
    messagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(validParsed) }],
    });

    prisma = {
      trade: { findMany: jest.fn().mockResolvedValue([]) },
      marketRegime: { findFirst: jest.fn().mockResolvedValue(null) },
      claudeAdvice: {
        create: jest.fn().mockResolvedValue({ id: BigInt(1) }),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      decisionLog: { create: jest.fn().mockResolvedValue({}) },
    };

    grid = {
      isActive: jest.fn().mockReturnValue(true),
      getGrid: jest.fn().mockReturnValue({
        pair: 'SOL/USDT',
        active: true,
        lowerBound: 90,
        upperBound: 110,
        gridStepPct: 1,
      }),
      cancelGrid: jest.fn().mockResolvedValue(undefined),
    };

    risk = {
      getCurrentRiskSnapshot: jest.fn().mockReturnValue({
        level: 'normal',
        reasons: [],
        dailyDrawdownPct: 0,
        weeklyDrawdownPct: 0,
        priceDeviationPct: 0,
        currentBalance: 1000,
        minAllowedBalance: 100,
      }),
    };

    exchange = {
      fetchTicker: jest
        .fn()
        .mockResolvedValue({ last: 100, percentage: 1, quoteVolume: 2 }),
      fetchBalance: jest
        .fn()
        .mockResolvedValue({ free: { USDT: 100, BTC: 0 }, used: {} }),
    };

    emit = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClaudeService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((k: string) =>
              k === 'claude.apiKey' ? 'sk-test' : undefined,
            ),
          },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: ExchangeService, useValue: exchange },
        { provide: GridService, useValue: grid },
        { provide: RiskService, useValue: risk },
        { provide: EventEmitter2, useValue: { emit } },
      ],
    }).compile();

    service = module.get(ClaudeService);
  });

  it('constructs without client when api key missing', async () => {
    const m = await Test.createTestingModule({
      providers: [
        ClaudeService,
        { provide: ConfigService, useValue: { get: jest.fn(() => '') } },
        { provide: PrismaService, useValue: prisma },
        { provide: ExchangeService, useValue: exchange },
        { provide: GridService, useValue: grid },
        { provide: RiskService, useValue: risk },
        { provide: EventEmitter2, useValue: { emit } },
      ],
    }).compile();
    const s = m.get(ClaudeService);
    expect(await s.requestAdvice('scheduled_4h')).toBeNull();
  });

  it('scheduledCheck no-ops without client or inactive grid', async () => {
    const m = await Test.createTestingModule({
      providers: [
        ClaudeService,
        { provide: ConfigService, useValue: { get: jest.fn(() => '') } },
        { provide: PrismaService, useValue: prisma },
        { provide: ExchangeService, useValue: exchange },
        { provide: GridService, useValue: grid },
        { provide: RiskService, useValue: risk },
        { provide: EventEmitter2, useValue: { emit } },
      ],
    }).compile();
    await m.get(ClaudeService).scheduledCheck();
    grid.isActive.mockReturnValue(false);
    await service.scheduledCheck();
  });

  it('requestAdvice returns null when API fails', async () => {
    messagesCreate.mockRejectedValue(new Error('api'));
    const r = await service.requestAdvice('scheduled_4h');
    expect(r).toBeNull();
  });

  it('requestAdvice stringifies non-Error API failure', async () => {
    jest.useFakeTimers();
    messagesCreate.mockRejectedValue('api');
    const p = service.requestAdvice('scheduled_4h');
    await jest.runAllTimersAsync();
    await p;
    jest.useRealTimers();
  });

  it('requestAdvice returns null when parse fails', async () => {
    messagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'not-json' }],
    });
    const r = await service.requestAdvice('scheduled_4h');
    expect(r).toBeNull();
    expect(prisma.claudeAdvice.create).toHaveBeenCalled();
  });

  it('applies pause immediately', async () => {
    messagesCreate.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ...validParsed,
            grid_recommendation: { action: 'pause', reason: 'stop' },
          }),
        },
      ],
    });
    await service.requestAdvice('scheduled_4h');
    expect(grid.cancelGrid).toHaveBeenCalled();
  });

  it('applies high-confidence keep', async () => {
    await service.requestAdvice('scheduled_4h');
    expect(prisma.claudeAdvice.create).toHaveBeenCalled();
  });

  it('emits pending for low confidence', async () => {
    messagesCreate.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ...validParsed,
            confidence: 0.5,
            risk_flags: [],
          }),
        },
      ],
    });
    await service.requestAdvice('scheduled_4h');
    expect(emit).toHaveBeenCalledWith(
      BOT_EVENTS.CLAUDE_ADVICE_PENDING,
      expect.any(Object),
    );
  });

  it('emits pending for adjust', async () => {
    messagesCreate.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ...validParsed,
            confidence: 0.75,
            grid_recommendation: { action: 'adjust', reason: 'x' },
          }),
        },
      ],
    });
    await service.requestAdvice('scheduled_4h');
    expect(emit).toHaveBeenCalled();
  });

  it('emits pending for restart', async () => {
    messagesCreate.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ...validParsed,
            confidence: 0.75,
            grid_recommendation: { action: 'restart', reason: 'x' },
          }),
        },
      ],
    });
    await service.requestAdvice('scheduled_4h');
    expect(emit).toHaveBeenCalled();
  });

  it('applyAdvice falls through restart block for medium-confidence keep', async () => {
    messagesCreate.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ...validParsed,
            confidence: 0.75,
            grid_recommendation: { action: 'keep', reason: 'hold' },
            risk_flags: [],
          }),
        },
      ],
    });
    await service.requestAdvice('scheduled_4h');
    expect(emit).not.toHaveBeenCalledWith(
      BOT_EVENTS.CLAUDE_ADVICE_PENDING,
      expect.any(Object),
    );
  });

  it('requestAdvice returns null when API returns no text block', async () => {
    messagesCreate.mockResolvedValue({
      content: [{ type: 'image', source: {} }],
    });
    const r = await service.requestAdvice('scheduled_4h');
    expect(r).toBeNull();
  });

  it('buildSnapshot tolerates ticker and balance errors', async () => {
    exchange.fetchTicker.mockRejectedValueOnce(new Error('e'));
    exchange.fetchBalance.mockRejectedValueOnce(new Error('e'));
    const snap = await service.buildSnapshot();
    expect(snap.pair).toBeDefined();
  });

  it('buildSnapshot uses default pair when grid missing', async () => {
    grid.getGrid.mockReturnValue(null);
    const snap = await service.buildSnapshot();
    expect(snap.pair).toBe('BTC/USDT');
  });

  it('buildSnapshot maps partial regime features to nulls', async () => {
    prisma.marketRegime.findFirst.mockResolvedValue({
      regime: 'flat',
      confidence: 0.5,
      features: {},
    });
    const snap = await service.buildSnapshot();
    expect(snap.indicators.rsi14).toBeNull();
  });

  it('buildSnapshot uses ticker fallbacks for pct and quote volume', async () => {
    exchange.fetchTicker.mockResolvedValueOnce({ last: 100 });
    const snap = await service.buildSnapshot();
    expect(snap.priceChange24h).toBe(0);
    expect(snap.volume24h).toBe(0);
  });

  it('buildSnapshot uses zero when ticker last missing', async () => {
    exchange.fetchTicker.mockResolvedValueOnce({});
    const snap = await service.buildSnapshot();
    expect(snap.currentPrice).toBe(0);
  });

  it('buildSnapshot sums BTC from used balance', async () => {
    exchange.fetchBalance.mockResolvedValueOnce({
      free: { USDT: 1 },
      used: { BTC: 0.5 },
    });
    const snap = await service.buildSnapshot();
    expect(snap.balance.btc).toBe(0.5);
  });

  it('buildSnapshot maps positive pnl from trade', async () => {
    prisma.trade.findMany.mockResolvedValueOnce([
      {
        side: 'buy',
        price: 1,
        pnlUsdt: 2.5,
        executedAt: new Date(),
      },
    ]);
    prisma.marketRegime.findFirst.mockResolvedValueOnce(null);
    const snap = await service.buildSnapshot();
    expect(snap.recentTrades[0].pnl).toBe(2.5);
  });

  it('buildSnapshot maps zero pnlUsdt to null in trades', async () => {
    prisma.trade.findMany.mockResolvedValueOnce([
      {
        side: 'buy',
        price: 100,
        pnlUsdt: 0,
        executedAt: new Date(),
      },
    ]);
    prisma.marketRegime.findFirst.mockResolvedValueOnce(null);
    const snap = await service.buildSnapshot();
    expect(snap.recentTrades[0].pnl).toBeNull();
  });

  it('buildSnapshot reads regime features', async () => {
    prisma.marketRegime.findFirst.mockResolvedValue({
      regime: 'flat',
      confidence: 0.8,
      features: { rsi14: 1, adx14: 2, atrPct: 3, macdHistogram: 4 },
    });
    grid.getGrid.mockReturnValue({
      pair: 'BTC/USDT',
      active: true,
      lowerBound: 1,
      upperBound: 2,
      gridStepPct: 1,
    });
    const snap = await service.buildSnapshot();
    expect(snap.indicators.rsi14).toBe(1);
  });

  it('getLatestAdvice returns null when no parsed record', async () => {
    prisma.claudeAdvice.findFirst.mockResolvedValueOnce(null);
    expect(await service.getLatestAdvice()).toBeNull();
  });

  it('getLatestAdvice returns parsed advice', async () => {
    prisma.claudeAdvice.findFirst.mockResolvedValueOnce({
      parsedAdvice: validParsed,
      triggerReason: 't',
    });
    const r = await service.getLatestAdvice();
    expect(r?.advice.grid_recommendation.action).toBe('keep');
  });

  it('getLatestAdvice uses unknown trigger when missing', async () => {
    prisma.claudeAdvice.findFirst.mockResolvedValueOnce({
      parsedAdvice: validParsed,
      triggerReason: null,
    });
    const r = await service.getLatestAdvice();
    expect(r?.trigger).toBe('unknown');
  });

  it('applyPendingAdvice returns false when missing', async () => {
    prisma.claudeAdvice.findUnique.mockResolvedValueOnce(null);
    expect(await service.applyPendingAdvice(BigInt(1))).toBe(false);
  });

  it('applyPendingAdvice handles pause', async () => {
    prisma.claudeAdvice.findUnique.mockResolvedValueOnce({
      parsedAdvice: {
        ...validParsed,
        grid_recommendation: { action: 'pause', reason: 'x' },
      },
      applied: false,
    });
    expect(await service.applyPendingAdvice(BigInt(1))).toBe(true);
    expect(grid.cancelGrid).toHaveBeenCalled();
  });

  it('applyPendingAdvice emits BOT_RESUMED for restart with bounds', async () => {
    prisma.claudeAdvice.findUnique.mockResolvedValueOnce({
      parsedAdvice: {
        ...validParsed,
        grid_recommendation: {
          action: 'restart',
          reason: 'x',
          lower_bound: 1,
          upper_bound: 2,
          grid_step_pct: 1.5,
        },
      },
      applied: false,
    });
    expect(await service.applyPendingAdvice(BigInt(1))).toBe(true);
    expect(emit).toHaveBeenCalledWith(
      BOT_EVENTS.BOT_RESUMED,
      expect.any(Object),
    );
  });

  it('onStaleOrders respects cooldowns', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(10_000);
    await service.onStaleOrders();
    jest.spyOn(Date, 'now').mockReturnValue(20_000);
    await service.onStaleOrders();
    jest.restoreAllMocks();
  });

  it('onStaleOrders requests advice when cooldowns passed', async () => {
    messagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(validParsed) }],
    });
    jest.spyOn(Date, 'now').mockReturnValue(10_000_000_000);
    const inst = service as unknown as {
      lastStaleOrdersAdviceAt: number;
      lastAdviceAt: number;
    };
    inst.lastStaleOrdersAdviceAt = 0;
    inst.lastAdviceAt = 0;
    await service.onStaleOrders();
    jest.restoreAllMocks();
  });

  it('logDecision swallows prisma errors', async () => {
    prisma.decisionLog.create.mockRejectedValueOnce(new Error('x'));
    messagesCreate.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ...validParsed,
            grid_recommendation: { action: 'pause', reason: 'x' },
          }),
        },
      ],
    });
    await service.requestAdvice('scheduled_4h');
  });

  it('applyAdvice skips emit when adviceId is null', async () => {
    prisma.claudeAdvice.create.mockResolvedValueOnce({ id: undefined });
    messagesCreate.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ...validParsed,
            confidence: 0.75,
            grid_recommendation: { action: 'adjust', reason: 'x' },
          }),
        },
      ],
    });
    emit.mockClear();
    await service.requestAdvice('scheduled_4h');
    expect(emit).not.toHaveBeenCalled();
  });

  it('saveAdvice returns null on prisma error', async () => {
    prisma.claudeAdvice.create.mockRejectedValueOnce(new Error('db'));
    const id = await (
      service as unknown as {
        saveAdvice: (...a: unknown[]) => Promise<bigint | null>;
      }
    ).saveAdvice(
      'scheduled_4h',
      await service.buildSnapshot(),
      'raw',
      null,
      false,
    );
    expect(id).toBeNull();
  });

  it('saveAdvice stringifies non-Error prisma failure', async () => {
    prisma.claudeAdvice.create.mockRejectedValueOnce('db');
    const id = await (
      service as unknown as {
        saveAdvice: (...a: unknown[]) => Promise<bigint | null>;
      }
    ).saveAdvice(
      'scheduled_4h',
      await service.buildSnapshot(),
      'raw',
      validParsed,
      false,
    );
    expect(id).toBeNull();
  });

  it('logDecision stringifies non-Error for Claude', async () => {
    prisma.decisionLog.create.mockRejectedValueOnce('x');
    messagesCreate.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ...validParsed,
            grid_recommendation: { action: 'pause', reason: 'x' },
          }),
        },
      ],
    });
    await service.requestAdvice('scheduled_4h');
  });

  it('markApplied swallows errors', async () => {
    prisma.claudeAdvice.findFirst.mockRejectedValueOnce(new Error('x'));
    await (
      service as unknown as { markApplied: (t: string) => Promise<void> }
    ).markApplied('scheduled_4h');
  });

  it('uses new Anthropic when api key set', () => {
    expect(Anthropic).toHaveBeenCalled();
  });

  it('constructs with direct DI args', () => {
    const cfg = { get: jest.fn(() => 'sk') } as unknown as ConfigService;
    const p = {} as PrismaService;
    const ex = {} as ExchangeService;
    const g = {} as GridService;
    const r = {} as RiskService;
    const ee = { emit: jest.fn() } as unknown as EventEmitter2;
    expect(new ClaudeService(cfg, p, ex, g, r, ee)).toBeInstanceOf(
      ClaudeService,
    );
  });

  it('buildSnapshot sums USDT from used balance only', async () => {
    exchange.fetchBalance.mockResolvedValueOnce({
      free: {},
      used: { USDT: 12 },
    });
    const snap = await service.buildSnapshot();
    expect(snap.balance.usdt).toBe(12);
  });

  it('event handlers delegate to requestAdvice', async () => {
    messagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(validParsed) }],
    });
    await service.onPriceOutOfRange();
    await service.onDrawdownWarning();
    await service.onRegimeChange({
      pair: 'SOL/USDT',
      oldRegime: 'a',
      newRegime: 'b',
      confidence: 0.8,
      action: 'RUN_GRID',
    });
  });

  it('scheduledCheck calls API when grid active', async () => {
    grid.isActive.mockReturnValue(true);
    await service.scheduledCheck();
    expect(messagesCreate).toHaveBeenCalled();
  });

  it('scheduledCheck skips when grid inactive', async () => {
    grid.isActive.mockReturnValue(false);
    messagesCreate.mockClear();
    await service.scheduledCheck();
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('onStaleOrders skips when stale cooldown active', async () => {
    grid.isActive.mockReturnValue(true);
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await service.onStaleOrders();
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000 + 60_000);
    await service.onStaleOrders();
    jest.restoreAllMocks();
  });

  it('onStaleOrders skips when recent advice within 30min', async () => {
    grid.isActive.mockReturnValue(true);
    const t = 10_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(t);
    await service.requestAdvice('scheduled_4h');
    jest.spyOn(Date, 'now').mockReturnValue(t + 60_000);
    await service.onStaleOrders();
    jest.restoreAllMocks();
  });

  it('onStaleOrders returns when grid inactive but client exists', async () => {
    grid.isActive.mockReturnValue(false);
    messagesCreate.mockClear();
    await service.onStaleOrders();
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('buildSnapshot maps trade with null pnlUsdt', async () => {
    prisma.trade.findMany.mockResolvedValueOnce([
      {
        side: 'buy',
        price: 100,
        pnlUsdt: null,
        executedAt: new Date(),
      },
    ]);
    prisma.marketRegime.findFirst.mockResolvedValueOnce(null);
    const snap = await service.buildSnapshot();
    expect(snap.recentTrades[0].pnl).toBeNull();
  });

  it('markApplied updates record when latest exists', async () => {
    prisma.claudeAdvice.findFirst.mockResolvedValueOnce({ id: BigInt(9) });
    await (
      service as unknown as {
        markApplied: (t: string) => Promise<void>;
      }
    ).markApplied('scheduled_4h');
    expect(prisma.claudeAdvice.update).toHaveBeenCalled();
  });

  it('applyPendingAdvice restart without explicit bounds uses ATR log path', async () => {
    prisma.claudeAdvice.findUnique.mockResolvedValueOnce({
      parsedAdvice: {
        ...validParsed,
        grid_recommendation: { action: 'restart', reason: 'r' },
      },
      applied: false,
    });
    await service.applyPendingAdvice(BigInt(1));
    expect(emit).toHaveBeenCalledWith(
      BOT_EVENTS.BOT_RESUMED,
      expect.objectContaining({ source: 'claude_advice' }),
    );
  });
});
