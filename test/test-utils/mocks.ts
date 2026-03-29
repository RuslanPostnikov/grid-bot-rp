import type { ConfigService } from '@nestjs/config';
import type { EventEmitter2 } from '@nestjs/event-emitter';

/** Minimal Prisma-like object for unit tests; extend per spec as needed. */
export function createMockPrisma(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
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
    candle: {
      count: jest.fn().mockResolvedValue(100),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    marketRegime: {
      create: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    claudeAdvice: {
      create: jest.fn().mockResolvedValue({ id: BigInt(1) }),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    },
    ...overrides,
  };
}

export function createMockConfigService(
  map: Record<string, unknown>,
): Pick<ConfigService, 'get'> {
  return {
    get: jest.fn((key: string, defaultValue?: unknown) => {
      if (key in map) return map[key];
      return defaultValue;
    }) as ConfigService['get'],
  };
}

export function createMockEventEmitter(): Pick<EventEmitter2, 'emit'> {
  return { emit: jest.fn() };
}
