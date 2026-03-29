import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MlService } from '@src/modules/ml/ml.service.js';
import { PrismaService } from '@src/prisma.service.js';
import { BOT_EVENTS } from '@src/common/events.js';

jest.mock('@src/modules/ml/market-features.js', () => ({
  calculateMarketFeatures: jest.fn(),
  calculateAvgBBWidth: jest.fn(),
  calculateAvgAtrPct: jest.fn(),
}));

jest.mock('@src/modules/ml/regime-classifier.js', () => ({
  classifyRegime: jest.fn(),
  regimeToAction: jest.fn(),
}));

import * as mf from '@src/modules/ml/market-features.js';
import * as rc from '@src/modules/ml/regime-classifier.js';

function candleRow(i: number) {
  return {
    open: String(100 + i),
    high: String(101 + i),
    low: String(99 + i),
    close: String(100 + i),
    volume: String(1000),
  };
}

describe('MlService', () => {
  let service: MlService;
  let prisma: Record<string, { findMany: jest.Mock; create: jest.Mock }>;
  let emit: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma = {
      candle: {
        findMany: jest.fn(),
        create: jest.fn(),
      },
      marketRegime: {
        findMany: jest.fn(),
        create: jest.fn().mockResolvedValue({}),
      },
    } as never;
    emit = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MlService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: { emit } },
      ],
    }).compile();

    service = module.get(MlService);
  });

  it('returns null when fewer than 60 candles', async () => {
    prisma.candle.findMany.mockResolvedValue(
      Array.from({ length: 59 }, (_, i) => candleRow(i)),
    );
    const r = await service.classifyCurrentRegime('SOL/USDT');
    expect(r).toBeNull();
    expect(prisma.marketRegime.create).not.toHaveBeenCalled();
  });

  it('queries explicit timeframe when passed', async () => {
    prisma.candle.findMany.mockResolvedValue(
      Array.from({ length: 59 }, (_, i) => candleRow(i)),
    );
    await service.classifyCurrentRegime('SOL/USDT', '1h');
    const findMany = prisma.candle.findMany as jest.MockedFunction<
      (q: { where: { pair: string; timeframe: string } }) => Promise<unknown>
    >;
    expect(findMany.mock.calls[0]?.[0].where.timeframe).toBe('1h');
  });

  it('constructs with prisma and emitter', () => {
    const p = {} as PrismaService;
    const e = { emit: jest.fn() } as unknown as EventEmitter2;
    expect(new MlService(p, e)).toBeInstanceOf(MlService);
  });

  it('returns null when features calculation returns null', async () => {
    prisma.candle.findMany.mockResolvedValue(
      Array.from({ length: 70 }, (_, i) => candleRow(i)),
    );
    (mf.calculateMarketFeatures as jest.Mock).mockReturnValue(null);
    (mf.calculateAvgBBWidth as jest.Mock).mockReturnValue(1);
    (mf.calculateAvgAtrPct as jest.Mock).mockReturnValue(1);
    const r = await service.classifyCurrentRegime('SOL/USDT');
    expect(r).toBeNull();
  });

  it('persists regime and emits when regime changes', async () => {
    prisma.candle.findMany.mockResolvedValue(
      Array.from({ length: 70 }, (_, i) => candleRow(i)),
    );
    (mf.calculateMarketFeatures as jest.Mock).mockReturnValue({
      adx14: 10,
      emaDiffPct: 0,
      atrPct: 1,
      bbWidth: 0.1,
      rsi14: 50,
      macdHistogram: 0,
      volumeRatio: 1,
    });
    (mf.calculateAvgBBWidth as jest.Mock).mockReturnValue(0.2);
    (mf.calculateAvgAtrPct as jest.Mock).mockReturnValue(1);
    (rc.classifyRegime as jest.Mock).mockReturnValue({
      regime: 'volatile',
      confidence: 0.8,
      reasons: [],
    });
    (rc.regimeToAction as jest.Mock).mockReturnValue('WIDEN_GRID');

    await service.classifyCurrentRegime('SOL/USDT', '4h');
    await service.classifyCurrentRegime('SOL/USDT', '4h');
    (rc.classifyRegime as jest.Mock).mockReturnValue({
      regime: 'flat',
      confidence: 0.7,
      reasons: [],
    });
    (rc.regimeToAction as jest.Mock).mockReturnValue('RUN_GRID');

    await service.classifyCurrentRegime('SOL/USDT', '4h');

    expect(prisma.marketRegime.create).toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      BOT_EVENTS.REGIME_CHANGE,
      expect.objectContaining({
        oldRegime: 'volatile',
        newRegime: 'flat',
      }),
    );
  });
});
