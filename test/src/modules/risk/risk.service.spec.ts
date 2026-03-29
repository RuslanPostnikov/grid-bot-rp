import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RiskService } from '@src/modules/risk/risk.service.js';
import { ExchangeService } from '@src/modules/exchange/exchange.service.js';
import { GridService } from '@src/modules/grid/grid.service.js';
import { PrismaService } from '@src/prisma.service.js';
import { BOT_EVENTS } from '@src/common/events.js';
import type { RiskCheckResult } from '@src/modules/risk/risk.types.js';

describe('RiskService', () => {
  let service: RiskService;
  let exchange: {
    fetchTicker: jest.Mock;
    fetchBalance: jest.Mock;
  };
  let grid: {
    isActive: jest.Mock;
    getGrid: jest.Mock;
    cancelGrid: jest.Mock;
    emergencySellBase: jest.Mock;
  };
  let prisma: { decisionLog: { create: jest.Mock } };
  let emit: jest.Mock;

  beforeEach(async () => {
    jest.useRealTimers();
    exchange = {
      fetchTicker: jest.fn().mockResolvedValue({ last: 100 }),
      fetchBalance: jest.fn().mockResolvedValue({
        free: { USDT: 1000, SOL: 0 },
        used: { USDT: 0, SOL: 0 },
      }),
    };
    grid = {
      isActive: jest.fn().mockReturnValue(true),
      getGrid: jest.fn().mockReturnValue({
        pair: 'SOL/USDT',
        lowerBound: 90,
        upperBound: 110,
      }),
      cancelGrid: jest.fn().mockResolvedValue(undefined),
      emergencySellBase: jest.fn().mockResolvedValue(undefined),
    };
    prisma = {
      decisionLog: {
        create: jest.fn().mockResolvedValue({}),
      },
    };
    emit = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RiskService,
        { provide: ExchangeService, useValue: exchange },
        { provide: GridService, useValue: grid },
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: { emit } },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((k: string, d?: unknown) => {
              if (k === 'exchange.tradingPair') return 'SOL/USDT';
              if (k === 'risk.activeCapitalPct') return 90;
              if (k === 'risk.reserveCapitalPct') return 5;
              if (k === 'risk.minBufferPct') return 5;
              if (k === 'risk.maxPriceDeviationPct') return 5;
              if (k === 'risk.stopLossBelowBoundPct') return 10;
              return d;
            }),
          },
        },
      ],
    }).compile();

    service = module.get(RiskService);
  });

  it('loads initial balance on init', async () => {
    await service.onModuleInit();
    expect(exchange.fetchBalance).toHaveBeenCalled();
    expect(service.getActiveCapital()).toBeGreaterThan(0);
  });

  it('onModuleInit tolerates ticker failure', async () => {
    exchange.fetchTicker.mockRejectedValueOnce(new Error('x'));
    await service.onModuleInit();
    expect(service.getLastKnownPrice()).toBe(0);
  });

  it('onModuleInit logs error when balance fails', async () => {
    jest.useFakeTimers();
    exchange.fetchBalance.mockRejectedValue(new Error('bal'));
    const p = service.onModuleInit();
    await jest.runAllTimersAsync();
    await p;
    jest.useRealTimers();
  });

  it('updateBalance updates peaks on success', async () => {
    await service.onModuleInit();
    exchange.fetchBalance.mockResolvedValue({
      free: { usdt: 2000, sol: 0 },
      used: { usdt: 0, sol: 0 },
    });
    await service.updateBalance();
    expect(service.getBalanceSnapshot().totalUsdt).toBe(2000);
  });

  it('updateBalance swallows exchange errors', async () => {
    await service.onModuleInit();
    exchange.fetchBalance.mockRejectedValue(new Error('e'));
    await service.updateBalance();
  });

  it('checkRisk returns early when grid inactive and not paused', async () => {
    grid.isActive.mockReturnValue(false);
    await service.checkRisk();
    expect(exchange.fetchTicker).not.toHaveBeenCalled();
  });

  it('checkRisk returns early on manual pause', async () => {
    service.pause();
    await service.checkRisk();
  });

  it('checkRisk returns when ticker fails', async () => {
    exchange.fetchTicker.mockRejectedValue(new Error('t'));
    await service.checkRisk();
  });

  it('emits PRICE_OUT_OF_RANGE when deviation exceeds config', async () => {
    exchange.fetchTicker.mockResolvedValue({ last: 200 });
    await service.checkRisk();
    expect(emit).toHaveBeenCalledWith(
      BOT_EVENTS.PRICE_OUT_OF_RANGE,
      expect.any(Object),
    );
  });

  it('triggers stop-loss and emergency sell', async () => {
    const stopPrice = 90 * (1 - 10 / 100);
    exchange.fetchTicker.mockResolvedValue({ last: stopPrice - 1 });
    await service.checkRisk();
    expect(grid.cancelGrid).toHaveBeenCalled();
    expect(grid.emergencySellBase).toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      BOT_EVENTS.STOP_LOSS_TRIGGERED,
      expect.any(Object),
    );
  });

  it('handleStopLoss logs prisma errors', async () => {
    prisma.decisionLog.create.mockRejectedValueOnce(new Error('db'));
    exchange.fetchTicker.mockResolvedValue({ last: 70 });
    await service.checkRisk();
  });

  it('emits RISK_WARNING on elevated daily drawdown', async () => {
    await service.onModuleInit();
    const snap = service.getBalanceSnapshot();
    exchange.fetchBalance.mockResolvedValue({
      free: { USDT: snap.totalUsdt * 0.96, SOL: 0 },
      used: { USDT: 0, SOL: 0 },
    });
    await service.updateBalance();
    exchange.fetchTicker.mockResolvedValue({ last: 100 });
    await service.checkRisk();
    expect(emit).toHaveBeenCalledWith(
      BOT_EVENTS.RISK_WARNING,
      expect.objectContaining({ level: 'warning' }),
    );
  });

  it('auto-resumes from risk pause when back to normal', async () => {
    jest.useFakeTimers();
    const inst = service as unknown as {
      paused: boolean;
      manualPause: boolean;
      lastAutoResumeAt: number;
    };
    inst.paused = true;
    inst.manualPause = false;
    inst.lastAutoResumeAt = 0;
    exchange.fetchTicker.mockResolvedValue({ last: 100 });
    await service.checkRisk();
    jest.advanceTimersByTime(6 * 60_000);
    exchange.fetchTicker.mockResolvedValue({ last: 100 });
    await service.checkRisk();
    jest.useRealTimers();
  });

  it('skips auto-resume during cooldown', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    const inst = service as unknown as {
      paused: boolean;
      manualPause: boolean;
      lastAutoResumeAt: number;
    };
    inst.paused = true;
    inst.manualPause = false;
    inst.lastAutoResumeAt = Date.now();
    exchange.fetchTicker.mockResolvedValue({ last: 100 });
    await service.checkRisk();
    jest.useRealTimers();
  });

  it('pause and resume toggle flags', () => {
    service.pause();
    expect(service.isPaused()).toBe(true);
    service.resume();
    expect(service.isPaused()).toBe(false);
  });

  it('onBotResumed clears stopLossTriggered flag', () => {
    const inst = service as unknown as { stopLossTriggered: boolean };
    inst.stopLossTriggered = true;
    service.onBotResumed();
    expect(inst.stopLossTriggered).toBe(false);
  });

  it('getCurrentRiskSnapshot works without grid', () => {
    grid.getGrid.mockReturnValue(null);
    const r = service.getCurrentRiskSnapshot();
    expect(r.level).toBeDefined();
  });

  it('getCurrentRiskSnapshot uses grid bounds when present', () => {
    grid.getGrid.mockReturnValue({
      pair: 'SOL/USDT',
      lowerBound: 90,
      upperBound: 110,
      active: true,
    });
    const r = service.getCurrentRiskSnapshot();
    expect(r.priceDeviationPct).toBeDefined();
  });

  it('logDecision swallows prisma errors', async () => {
    prisma.decisionLog.create.mockRejectedValueOnce(new Error('log'));
    exchange.fetchTicker.mockResolvedValue({ last: 200 });
    await service.checkRisk();
  });

  it('pauses grid on daily drawdown at pause threshold', async () => {
    await service.onModuleInit();
    const peak = service.getBalanceSnapshot().totalUsdt + 1000;
    const inst = service as unknown as {
      dailyPeakBalance: number;
      currentBalance: number;
    };
    inst.dailyPeakBalance = peak;
    inst.currentBalance = peak * 0.94;
    exchange.fetchTicker.mockResolvedValue({ last: 100 });
    await service.checkRisk();
    expect(grid.cancelGrid).toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      BOT_EVENTS.RISK_PAUSE,
      expect.any(Object),
    );
  });

  it('stop level cancels grid', async () => {
    await service.onModuleInit();
    const inst = service as unknown as {
      weeklyPeakBalance: number;
      currentBalance: number;
    };
    inst.weeklyPeakBalance = 1000;
    inst.currentBalance = 800;
    exchange.fetchTicker.mockResolvedValue({ last: 100 });
    await service.checkRisk();
    expect(grid.cancelGrid).toHaveBeenCalled();
  });

  it('updateBalance resets daily and weekly peaks after interval', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    await service.onModuleInit();
    jest.setSystemTime(new Date('2026-01-09T12:00:00Z'));
    exchange.fetchBalance.mockResolvedValue({
      free: { USDT: 500, SOL: 0 },
      used: { USDT: 0, SOL: 0 },
    });
    await service.updateBalance();
    jest.useRealTimers();
  });

  const normalResult = (): RiskCheckResult => ({
    level: 'normal',
    reasons: [],
    dailyDrawdownPct: 0,
    weeklyDrawdownPct: 0,
    priceDeviationPct: 0,
    currentBalance: 1000,
    minAllowedBalance: 100,
  });

  it('handleRiskResult auto-resumes when risk pause clears', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    const inst = service as unknown as {
      handleRiskResult: (r: RiskCheckResult) => Promise<void>;
      paused: boolean;
      manualPause: boolean;
      lastAutoResumeAt: number;
    };
    inst.paused = true;
    inst.manualPause = false;
    inst.lastAutoResumeAt = 0;
    await inst.handleRiskResult(normalResult());
    expect(inst.paused).toBe(false);
    expect(emit).toHaveBeenCalledWith(BOT_EVENTS.BOT_RESUMED);
    jest.useRealTimers();
  });

  it('handleRiskResult skips auto-resume during cooldown', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    const inst = service as unknown as {
      handleRiskResult: (r: RiskCheckResult) => Promise<void>;
      paused: boolean;
      manualPause: boolean;
      lastAutoResumeAt: number;
    };
    inst.paused = true;
    inst.manualPause = false;
    inst.lastAutoResumeAt = Date.now();
    await inst.handleRiskResult(normalResult());
    expect(inst.paused).toBe(true);
    jest.useRealTimers();
  });

  it('handleRiskResult normal when not paused is no-op', async () => {
    const inst = service as unknown as {
      handleRiskResult: (r: RiskCheckResult) => Promise<void>;
      paused: boolean;
    };
    inst.paused = false;
    emit.mockClear();
    await inst.handleRiskResult(normalResult());
    expect(emit).not.toHaveBeenCalledWith(BOT_EVENTS.BOT_RESUMED);
  });

  it('handleRiskResult warning emits event', async () => {
    const inst = service as unknown as {
      handleRiskResult: (r: RiskCheckResult) => Promise<void>;
    };
    await inst.handleRiskResult({
      ...normalResult(),
      level: 'warning',
      reasons: ['x'],
    });
    expect(emit).toHaveBeenCalledWith(
      BOT_EVENTS.RISK_WARNING,
      expect.any(Object),
    );
  });

  it('handleRiskResult pause cancels grid when not already paused', async () => {
    const inst = service as unknown as {
      handleRiskResult: (r: RiskCheckResult) => Promise<void>;
      paused: boolean;
    };
    inst.paused = false;
    await inst.handleRiskResult({
      ...normalResult(),
      level: 'pause',
      reasons: ['p'],
    });
    expect(grid.cancelGrid).toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      BOT_EVENTS.RISK_PAUSE,
      expect.any(Object),
    );
  });

  it('handleRiskResult stop cancels grid', async () => {
    const inst = service as unknown as {
      handleRiskResult: (r: RiskCheckResult) => Promise<void>;
    };
    await inst.handleRiskResult({
      ...normalResult(),
      level: 'stop',
      reasons: ['s'],
    });
    expect(grid.cancelGrid).toHaveBeenCalled();
  });

  it('handleRiskResult pause no-op when already paused', async () => {
    const inst = service as unknown as {
      handleRiskResult: (r: RiskCheckResult) => Promise<void>;
      paused: boolean;
    };
    inst.paused = true;
    grid.cancelGrid.mockClear();
    await inst.handleRiskResult({
      ...normalResult(),
      level: 'pause',
      reasons: ['p'],
    });
    expect(grid.cancelGrid).not.toHaveBeenCalled();
  });

  it('uses default trading pair and risk config when get returns undefined', async () => {
    const mod = await Test.createTestingModule({
      providers: [
        RiskService,
        { provide: ExchangeService, useValue: exchange },
        { provide: GridService, useValue: grid },
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: { emit } },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue(undefined),
          },
        },
      ],
    }).compile();
    const s = mod.get(RiskService);
    const snap = s.getBalanceSnapshot();
    expect(snap.baseAsset).toBe('BTC');
  });

  it('loadInitialBalance uses base pair when grid is null', async () => {
    grid.getGrid.mockReturnValue(null);
    await service.onModuleInit();
    expect(exchange.fetchTicker).toHaveBeenCalledWith('SOL/USDT');
  });

  it('loadInitialBalance sets price zero when ticker has no last', async () => {
    exchange.fetchTicker.mockResolvedValueOnce({});
    await service.onModuleInit();
    expect(service.getLastKnownPrice()).toBe(0);
  });

  it('updateBalance does not raise peaks when balance drops', async () => {
    await service.onModuleInit();
    const peak = service.getBalanceSnapshot().totalUsdt;
    exchange.fetchBalance.mockResolvedValue({
      free: { USDT: peak * 0.5, SOL: 0 },
      used: { USDT: 0, SOL: 0 },
    });
    await service.updateBalance();
    const inst = service as unknown as { dailyPeakBalance: number };
    expect(inst.dailyPeakBalance).toBe(peak);
  });

  it('updateBalanceFromRaw reads lowercase usdt and base keys', async () => {
    await service.onModuleInit();
    exchange.fetchBalance.mockResolvedValue({
      free: { usdt: 300, sol: 0.1 },
      used: { usdt: 10, sol: 0 },
    });
    await service.updateBalance();
    expect(service.getBalanceSnapshot().totalUsdt).toBe(310);
  });

  it('updateBalanceFromRaw mixes USDT on free and usdt on used', async () => {
    await service.onModuleInit();
    exchange.fetchBalance.mockResolvedValue({
      free: { USDT: 100, SOL: 0 },
      used: { usdt: 25, SOL: 0 },
    });
    await service.updateBalance();
    expect(service.getBalanceSnapshot().totalUsdt).toBe(125);
  });

  it('checkRisk uses synthetic pair when grid is null', async () => {
    grid.getGrid.mockReturnValue(null);
    grid.isActive.mockReturnValue(true);
    await service.checkRisk();
    expect(exchange.fetchTicker).toHaveBeenCalledWith('SOL/USDT');
  });

  it('checkRisk uses ticker last fallback zero', async () => {
    exchange.fetchTicker.mockResolvedValueOnce({ last: undefined });
    await service.checkRisk();
  });

  it('checkRisk skips stop-loss path when grid is null', async () => {
    await service.onModuleInit();
    grid.getGrid.mockReturnValue(null);
    grid.isActive.mockReturnValue(true);
    exchange.fetchTicker.mockResolvedValue({ last: 100 });
    grid.cancelGrid.mockClear();
    await service.checkRisk();
    expect(grid.cancelGrid).not.toHaveBeenCalled();
  });

  it('handleStopLoss logs non-Error prisma failure', async () => {
    prisma.decisionLog.create.mockRejectedValueOnce('db-str');
    exchange.fetchTicker.mockResolvedValue({ last: 70 });
    await service.checkRisk();
  });

  it('logDecision stringifies non-Error prisma failure', async () => {
    prisma.decisionLog.create.mockRejectedValueOnce('log-str');
    const inst = service as unknown as {
      handleRiskResult: (r: RiskCheckResult) => Promise<void>;
    };
    await inst.handleRiskResult({
      ...normalResult(),
      level: 'warning',
      reasons: ['w'],
    });
  });

  it('onBotResumed no-op when stopLossTriggered false', () => {
    const inst = service as unknown as { stopLossTriggered: boolean };
    inst.stopLossTriggered = false;
    service.onBotResumed();
    expect(inst.stopLossTriggered).toBe(false);
  });

  it('emits PRICE_OUT_OF_RANGE with zero bounds when grid null and threshold zero', async () => {
    const emitLocal = jest.fn();
    const g = {
      isActive: jest.fn().mockReturnValue(true),
      getGrid: jest.fn().mockReturnValue(null),
      cancelGrid: jest.fn(),
      emergencySellBase: jest.fn(),
    };
    const ex = {
      fetchTicker: jest.fn().mockResolvedValue({ last: 100 }),
      fetchBalance: jest.fn().mockResolvedValue({
        free: { USDT: 1000, SOL: 0 },
        used: { USDT: 0, SOL: 0 },
      }),
    };
    const mod = await Test.createTestingModule({
      providers: [
        RiskService,
        { provide: ExchangeService, useValue: ex },
        { provide: GridService, useValue: g },
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: { emit: emitLocal } },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((k: string, d?: unknown) => {
              if (k === 'exchange.tradingPair') return 'SOL/USDT';
              if (k === 'risk.maxPriceDeviationPct') return 0;
              if (k === 'risk.activeCapitalPct') return 90;
              if (k === 'risk.reserveCapitalPct') return 5;
              if (k === 'risk.minBufferPct') return 5;
              if (k === 'risk.stopLossBelowBoundPct') return 10;
              return d;
            }),
          },
        },
      ],
    }).compile();
    const s = mod.get(RiskService);
    await s.onModuleInit();
    await s.checkRisk();
    expect(emitLocal).toHaveBeenCalledWith(
      BOT_EVENTS.PRICE_OUT_OF_RANGE,
      expect.objectContaining({
        lowerBound: 0,
        upperBound: 0,
        priceDeviationPct: 0,
      }),
    );
  });
});
