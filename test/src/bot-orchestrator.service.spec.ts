import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as ti from 'technicalindicators';
import { BotOrchestratorService } from '@src/bot-orchestrator.service.js';
import { ExchangeService } from '@src/modules/exchange/exchange.service.js';
import { GridService } from '@src/modules/grid/grid.service.js';
import { type RegimeChangePayload } from '@src/common/events.js';

jest.mock('technicalindicators', () => ({
  ATR: {
    calculate: jest.fn().mockReturnValue(Array(20).fill(100)),
  },
}));

describe('BotOrchestratorService', () => {
  let service: BotOrchestratorService;
  let exchange: {
    fetchTicker: jest.Mock;
    fetchOHLCV: jest.Mock;
    fetchBalance: jest.Mock;
  };
  let grid: {
    isActive: jest.Mock;
    getGrid: jest.Mock;
    cancelGrid: jest.Mock;
    setupGrid: jest.Mock;
    setupGridWithParams: jest.Mock;
    rebalanceGrid: jest.Mock;
  };
  let config: { get: jest.Mock };

  const ohlcvEnough = () =>
    Array.from({ length: 20 }, () => [0, 0, 100, 90, 95, 0] as number[]);

  beforeEach(async () => {
    jest.useRealTimers();
    exchange = {
      fetchTicker: jest.fn().mockResolvedValue({ last: 100 }),
      fetchOHLCV: jest.fn().mockResolvedValue(ohlcvEnough()),
      fetchBalance: jest.fn().mockResolvedValue({
        free: { USDT: 200 },
        used: { USDT: 0 },
      }),
    };
    grid = {
      isActive: jest.fn().mockReturnValue(false),
      getGrid: jest.fn().mockReturnValue(null),
      cancelGrid: jest.fn().mockResolvedValue(undefined),
      setupGrid: jest.fn().mockResolvedValue(undefined),
      setupGridWithParams: jest.fn().mockResolvedValue(undefined),
      rebalanceGrid: jest.fn().mockResolvedValue(undefined),
    };
    config = {
      get: jest.fn((k: string, d?: unknown) => {
        if (k === 'exchange.tradingPair') return 'SOL/USDT';
        if (k === 'risk.activeCapitalPct') return 90;
        return d;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BotOrchestratorService,
        { provide: ExchangeService, useValue: exchange },
        { provide: GridService, useValue: grid },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = module.get(BotOrchestratorService);
  });

  it('onApplicationBootstrap starts auto-setup when no grid', async () => {
    await service.onApplicationBootstrap();
    expect(grid.setupGrid).toHaveBeenCalled();
  });

  it('onApplicationBootstrap skips when grid active with orders', async () => {
    grid.isActive.mockReturnValue(true);
    grid.getGrid.mockReturnValue({
      orders: [{ status: 'placed' }],
    });
    await service.onApplicationBootstrap();
    expect(grid.setupGrid).not.toHaveBeenCalled();
  });

  it('onApplicationBootstrap cancels empty active grid then sets up', async () => {
    grid.isActive.mockReturnValue(true);
    grid.getGrid.mockReturnValue({ orders: [] });
    await service.onApplicationBootstrap();
    expect(grid.cancelGrid).toHaveBeenCalled();
    expect(grid.setupGrid).toHaveBeenCalled();
  });

  it('onBotResumed skips when grid already active', async () => {
    grid.isActive.mockReturnValue(true);
    await service.onBotResumed();
    expect(grid.setupGrid).not.toHaveBeenCalled();
  });

  it('onBotResumed applies suggestedParams', async () => {
    await service.onBotResumed({
      source: 'claude_advice',
      suggestedParams: {
        lowerBound: 80,
        upperBound: 120,
        gridStepPct: 1,
      },
    });
    expect(grid.setupGridWithParams).toHaveBeenCalledWith(
      'SOL/USDT',
      100,
      180,
      80,
      120,
      1,
    );
  });

  it('onBotResumed falls back when suggestedParams setup throws', async () => {
    grid.setupGridWithParams.mockRejectedValueOnce(new Error('fail'));
    await service.onBotResumed({
      source: 'claude_advice',
      suggestedParams: {
        lowerBound: 80,
        upperBound: 120,
        gridStepPct: 1,
      },
    });
    expect(grid.setupGrid).toHaveBeenCalled();
  });

  it('onBotResumed stringifies non-Error when suggestedParams path fails', async () => {
    grid.setupGridWithParams.mockRejectedValueOnce('bad');
    await service.onBotResumed({
      source: 'claude_advice',
      suggestedParams: {
        lowerBound: 80,
        upperBound: 120,
        gridStepPct: 1,
      },
    });
    expect(grid.setupGrid).toHaveBeenCalled();
  });

  it('onBotResumed without suggestedParams runs auto setup', async () => {
    await service.onBotResumed({ source: 'manual' });
    expect(grid.setupGrid).toHaveBeenCalled();
  });

  it('onRegimeChange ignores low confidence', async () => {
    const p: RegimeChangePayload = {
      pair: 'SOL/USDT',
      oldRegime: 'flat',
      newRegime: 'uptrend',
      confidence: 0.4,
      action: 'SHIFT_UP',
    };
    await service.onRegimeChange(p);
    expect(grid.rebalanceGrid).not.toHaveBeenCalled();
  });

  it('onRegimeChange respects cooldown', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const p: RegimeChangePayload = {
      pair: 'SOL/USDT',
      oldRegime: 'flat',
      newRegime: 'uptrend',
      confidence: 0.9,
      action: 'RUN_GRID',
    };
    await service.onRegimeChange(p);
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000 + 60_000);
    await service.onRegimeChange({
      ...p,
      action: 'PAUSE',
    });
    jest.restoreAllMocks();
  });

  it('RUN_GRID starts grid when inactive', async () => {
    const p: RegimeChangePayload = {
      pair: 'SOL/USDT',
      oldRegime: null,
      newRegime: 'flat',
      confidence: 0.9,
      action: 'RUN_GRID',
    };
    await service.onRegimeChange(p);
    expect(grid.setupGrid).toHaveBeenCalled();
  });

  it('SHIFT_UP rebalances when grid active', async () => {
    grid.isActive.mockReturnValue(true);
    grid.getGrid.mockReturnValue({
      gridStepPct: 1,
      lowerBound: 90,
      upperBound: 110,
    });
    const p: RegimeChangePayload = {
      pair: 'SOL/USDT',
      oldRegime: 'flat',
      newRegime: 'uptrend',
      confidence: 0.9,
      action: 'SHIFT_UP',
    };
    await service.onRegimeChange(p);
    expect(grid.rebalanceGrid).toHaveBeenCalled();
  });

  it('PAUSE cancels when grid active', async () => {
    grid.isActive.mockReturnValue(true);
    await service.onRegimeChange({
      pair: 'SOL/USDT',
      oldRegime: 'up',
      newRegime: 'down',
      confidence: 0.9,
      action: 'PAUSE',
    });
    expect(grid.cancelGrid).toHaveBeenCalled();
  });

  it('WIDEN_GRID rebalances when grid active', async () => {
    grid.isActive.mockReturnValue(true);
    grid.getGrid.mockReturnValue({ gridStepPct: 1 });
    await service.onRegimeChange({
      pair: 'SOL/USDT',
      oldRegime: 'flat',
      newRegime: 'volatile',
      confidence: 0.9,
      action: 'WIDEN_GRID',
    });
    expect(grid.rebalanceGrid).toHaveBeenCalled();
  });

  it('onRegimeChange catches errors from actions', async () => {
    grid.isActive.mockReturnValue(true);
    grid.getGrid.mockReturnValue({ gridStepPct: 1 });
    grid.rebalanceGrid.mockRejectedValueOnce(new Error('boom'));
    await service.onRegimeChange({
      pair: 'SOL/USDT',
      oldRegime: 'a',
      newRegime: 'b',
      confidence: 0.9,
      action: 'WIDEN_GRID',
    });
  });

  it('autoSetupWithRetry retries then succeeds', async () => {
    jest.useFakeTimers();
    grid.setupGrid
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce(undefined);
    const p = service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(10_000);
    await p;
    expect(grid.setupGrid).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('autoSetupWithRetry logs after max failures', async () => {
    jest.useFakeTimers();
    grid.setupGrid.mockRejectedValue(new Error('always'));
    const p = service.onApplicationBootstrap();
    for (let i = 0; i < 9; i++) {
      await jest.advanceTimersByTimeAsync(10_000);
    }
    await p;
    expect(grid.setupGrid).toHaveBeenCalledTimes(10);
    jest.useRealTimers();
  });

  it('fetchAtrData returns null on exchange error', async () => {
    exchange.fetchTicker.mockRejectedValueOnce(new Error('net'));
    const data = await (
      service as unknown as { fetchAtrData: () => Promise<unknown> }
    ).fetchAtrData();
    expect(data).toBeNull();
  });

  it('fetchAtrData returns null when not enough candles', async () => {
    exchange.fetchOHLCV.mockResolvedValueOnce([[0, 0, 1, 1, 1, 1]]);
    const data = await (
      service as unknown as { fetchAtrData: () => Promise<unknown> }
    ).fetchAtrData();
    expect(data).toBeNull();
  });

  it('autoSetupGrid throws when price missing', async () => {
    exchange.fetchTicker.mockResolvedValueOnce({ last: undefined });
    await expect(
      (
        service as unknown as { autoSetupGrid: () => Promise<void> }
      ).autoSetupGrid(),
    ).rejects.toThrow('Cannot get current price');
  });

  it('autoSetupGrid throws when not enough candles', async () => {
    exchange.fetchOHLCV.mockResolvedValueOnce([]);
    await expect(
      (
        service as unknown as { autoSetupGrid: () => Promise<void> }
      ).autoSetupGrid(),
    ).rejects.toThrow('Not enough candles');
  });

  it('fetchPriceAndCapital throws when ticker last missing', async () => {
    exchange.fetchTicker.mockResolvedValueOnce({ last: undefined });
    await expect(
      (
        service as unknown as {
          fetchPriceAndCapital: () => Promise<unknown>;
        }
      ).fetchPriceAndCapital(),
    ).rejects.toThrow('Cannot get current price');
  });

  it('fetchAtrData catch uses String for non-Error', async () => {
    exchange.fetchTicker.mockRejectedValueOnce('x');
    const data = await (
      service as unknown as { fetchAtrData: () => Promise<unknown> }
    ).fetchAtrData();
    expect(data).toBeNull();
  });

  it('fetchPriceAndCapital throws on zero USDT', async () => {
    exchange.fetchBalance.mockResolvedValueOnce({
      free: { USDT: 0 },
      used: { USDT: 0 },
    });
    await expect(
      (
        service as unknown as {
          fetchPriceAndCapital: () => Promise<unknown>;
        }
      ).fetchPriceAndCapital(),
    ).rejects.toThrow('No USDT balance');
  });

  it('autoSetupGrid throws when USDT balance is zero', async () => {
    exchange.fetchOHLCV.mockResolvedValue(ohlcvEnough());
    exchange.fetchBalance.mockResolvedValueOnce({
      free: { USDT: 0 },
      used: { USDT: 0 },
    });
    await expect(
      (
        service as unknown as { autoSetupGrid: () => Promise<void> }
      ).autoSetupGrid(),
    ).rejects.toThrow('No USDT balance');
  });

  it('uses default trading pair when config omits it', async () => {
    config.get.mockImplementation((_k: string, d?: unknown) => d);
    const module = await Test.createTestingModule({
      providers: [
        BotOrchestratorService,
        { provide: ExchangeService, useValue: exchange },
        { provide: GridService, useValue: grid },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    const s = module.get(BotOrchestratorService);
    await s.onApplicationBootstrap();
    expect(grid.setupGrid).toHaveBeenCalledWith(
      'BTC/USDT',
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    );
  });

  it('onApplicationBootstrap skips when active but getGrid is null', async () => {
    grid.isActive.mockReturnValue(true);
    grid.getGrid.mockReturnValue(null);
    await service.onApplicationBootstrap();
    expect(grid.setupGrid).not.toHaveBeenCalled();
  });

  it('autoSetupWithRetry stringifies non-Error on last failure', async () => {
    jest.useFakeTimers();
    grid.setupGrid.mockRejectedValue('plain');
    const p = service.onApplicationBootstrap();
    for (let i = 0; i < 9; i++) {
      await jest.advanceTimersByTimeAsync(10_000);
    }
    await p;
    jest.useRealTimers();
  });

  it('fetchAtrData returns null when ticker has no last', async () => {
    exchange.fetchTicker.mockResolvedValueOnce({ last: undefined });
    const data = await (
      service as unknown as { fetchAtrData: () => Promise<unknown> }
    ).fetchAtrData();
    expect(data).toBeNull();
  });

  it('fetchAtrData returns null when last ATR value is falsy', async () => {
    jest.spyOn(ti.ATR, 'calculate').mockReturnValueOnce([0, 0, 0]);
    const data = await (
      service as unknown as { fetchAtrData: () => Promise<unknown> }
    ).fetchAtrData();
    expect(data).toBeNull();
    jest.restoreAllMocks();
  });

  it('fetchAtrData succeeds and returns avg metrics', async () => {
    const atrSeries: number[] = Array.from({ length: 20 }, (): number => 50);
    jest.spyOn(ti.ATR, 'calculate').mockReturnValueOnce(atrSeries);
    const data = (await (
      service as unknown as { fetchAtrData: () => Promise<unknown> }
    ).fetchAtrData()) as {
      currentPrice: number;
      atr14: number;
      avgAtrPct: number;
    };
    expect(data.currentPrice).toBe(100);
    expect(data.atr14).toBe(50);
    expect(typeof data.avgAtrPct).toBe('number');
    jest.restoreAllMocks();
  });

  it('autoSetupGrid throws when ATR tail is falsy', async () => {
    jest.spyOn(ti.ATR, 'calculate').mockReturnValueOnce([]);
    await expect(
      (
        service as unknown as { autoSetupGrid: () => Promise<void> }
      ).autoSetupGrid(),
    ).rejects.toThrow('ATR calculation failed');
    jest.restoreAllMocks();
  });

  it('fetchPriceAndCapital accepts lowercase usdt keys', async () => {
    exchange.fetchBalance.mockResolvedValueOnce({
      free: { usdt: 50 },
      used: { usdt: 50 },
    });
    const r = await (
      service as unknown as {
        fetchPriceAndCapital: () => Promise<{
          currentPrice: number;
          activeCapital: number;
        }>;
      }
    ).fetchPriceAndCapital();
    expect(r.activeCapital).toBe(90);
  });

  it('fetchPriceAndCapital mixes USDT and usdt across free and used', async () => {
    exchange.fetchBalance.mockResolvedValueOnce({
      free: { USDT: 60 },
      used: { usdt: 40 },
    });
    const r = await (
      service as unknown as {
        fetchPriceAndCapital: () => Promise<{ activeCapital: number }>;
      }
    ).fetchPriceAndCapital();
    expect(r.activeCapital).toBe(90);
  });

  it('fetchPriceAndCapital uses default activeCapitalPct', async () => {
    config.get.mockImplementation((k: string, d?: unknown) => {
      if (k === 'exchange.tradingPair') return 'SOL/USDT';
      return d;
    });
    const r = await (
      service as unknown as {
        fetchPriceAndCapital: () => Promise<{ activeCapital: number }>;
      }
    ).fetchPriceAndCapital();
    expect(r.activeCapital).toBe(180);
  });

  it('RUN_GRID does nothing when grid already active', async () => {
    grid.isActive.mockReturnValue(true);
    jest.spyOn(Date, 'now').mockReturnValue(10_000_000_000);
    await service.onRegimeChange({
      pair: 'SOL/USDT',
      oldRegime: 'x',
      newRegime: 'flat',
      confidence: 0.9,
      action: 'RUN_GRID',
    });
    expect(grid.setupGrid).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it('SHIFT_UP no-op when grid inactive', async () => {
    grid.isActive.mockReturnValue(false);
    jest.spyOn(Date, 'now').mockReturnValue(10_000_000_000);
    await service.onRegimeChange({
      pair: 'SOL/USDT',
      oldRegime: 'a',
      newRegime: 'b',
      confidence: 0.9,
      action: 'SHIFT_UP',
    });
    expect(grid.rebalanceGrid).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it('SHIFT_UP skips rebalance when ATR data missing', async () => {
    grid.isActive.mockReturnValue(true);
    grid.getGrid.mockReturnValue({ gridStepPct: 1 });
    exchange.fetchTicker.mockResolvedValueOnce({ last: undefined });
    jest.spyOn(Date, 'now').mockReturnValue(10_000_000_000);
    await service.onRegimeChange({
      pair: 'SOL/USDT',
      oldRegime: 'a',
      newRegime: 'b',
      confidence: 0.9,
      action: 'SHIFT_UP',
    });
    expect(grid.rebalanceGrid).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it('WIDEN_GRID skips rebalance when ATR data missing', async () => {
    grid.isActive.mockReturnValue(true);
    grid.getGrid.mockReturnValue({ gridStepPct: 1 });
    exchange.fetchTicker.mockResolvedValueOnce({ last: undefined });
    jest.spyOn(Date, 'now').mockReturnValue(10_000_000_000);
    await service.onRegimeChange({
      pair: 'SOL/USDT',
      oldRegime: 'a',
      newRegime: 'volatile',
      confidence: 0.9,
      action: 'WIDEN_GRID',
    });
    expect(grid.rebalanceGrid).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it('WIDEN_GRID no-op when grid inactive', async () => {
    grid.isActive.mockReturnValue(false);
    jest.spyOn(Date, 'now').mockReturnValue(10_000_000_000);
    await service.onRegimeChange({
      pair: 'SOL/USDT',
      oldRegime: 'a',
      newRegime: 'volatile',
      confidence: 0.9,
      action: 'WIDEN_GRID',
    });
    expect(grid.rebalanceGrid).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it('PAUSE no-op when grid inactive', async () => {
    grid.isActive.mockReturnValue(false);
    jest.spyOn(Date, 'now').mockReturnValue(10_000_000_000);
    await service.onRegimeChange({
      pair: 'SOL/USDT',
      oldRegime: 'a',
      newRegime: 'b',
      confidence: 0.9,
      action: 'PAUSE',
    });
    expect(grid.cancelGrid).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it('onRegimeChange logs non-Error from catch', async () => {
    grid.isActive.mockReturnValue(true);
    grid.getGrid.mockReturnValue({ gridStepPct: 1 });
    grid.rebalanceGrid.mockRejectedValueOnce('boom');
    jest.spyOn(Date, 'now').mockReturnValue(10_000_000_000);
    await service.onRegimeChange({
      pair: 'SOL/USDT',
      oldRegime: 'a',
      newRegime: 'b',
      confidence: 0.9,
      action: 'WIDEN_GRID',
    });
    jest.restoreAllMocks();
  });

  it('autoSetupGrid uses default activeCapitalPct when unset', async () => {
    config.get.mockImplementation((k: string, d?: unknown) => {
      if (k === 'exchange.tradingPair') return 'SOL/USDT';
      return d;
    });
    await (
      service as unknown as { autoSetupGrid: () => Promise<void> }
    ).autoSetupGrid();
    expect(grid.setupGrid).toHaveBeenCalledWith('SOL/USDT', 100, 100, 180);
  });

  it('autoSetupGrid mixes USDT on free and usdt on used', async () => {
    exchange.fetchBalance.mockResolvedValueOnce({
      free: { USDT: 120 },
      used: { usdt: 80 },
    });
    await (
      service as unknown as { autoSetupGrid: () => Promise<void> }
    ).autoSetupGrid();
    expect(grid.setupGrid).toHaveBeenCalled();
  });

  it('autoSetupGrid reads lowercase usdt keys on balance', async () => {
    exchange.fetchBalance.mockResolvedValueOnce({
      free: { usdt: 100 },
      used: { usdt: 100 },
    });
    await (
      service as unknown as { autoSetupGrid: () => Promise<void> }
    ).autoSetupGrid();
    expect(grid.setupGrid).toHaveBeenCalled();
  });

  it('constructs with direct DI args', () => {
    const s = new BotOrchestratorService(
      exchange as unknown as ExchangeService,
      grid as unknown as GridService,
      config as unknown as ConfigService,
    );
    expect(s).toBeDefined();
  });
});
