import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { BotOrchestratorService } from '@src/bot-orchestrator.service.js';
import { PrismaService } from '@src/prisma.service.js';
import { CollectorService } from '@src/modules/collector/collector.service.js';
import { ExchangeService } from '@src/modules/exchange/exchange.service.js';
import { TelegramService } from '@src/modules/telegram/telegram.service.js';
import { AppModule } from '@src/app.module.js';
import { createMockPrisma } from '../test-utils/mocks.js';

const noopExchange = {
  onModuleInit: jest.fn(),
  getExchange: jest.fn(),
  fetchOHLCV: jest.fn(),
  fetchTicker: jest.fn(),
  fetchBalance: jest.fn(),
};

describe('AppModule', () => {
  afterEach(() => {
    delete process.env.NODE_ENV;
  });

  async function compileWithNodeEnv(nodeEnv: string | undefined) {
    if (nodeEnv !== undefined) process.env.NODE_ENV = nodeEnv;
    else delete process.env.NODE_ENV;

    return Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ExchangeService)
      .useValue(noopExchange)
      .overrideProvider(PrismaService)
      .useValue(createMockPrisma())
      .overrideProvider(CollectorService)
      .useValue({ onModuleInit: jest.fn() })
      .overrideProvider(TelegramService)
      .useValue({
        onModuleInit: jest.fn(),
        onModuleDestroy: jest.fn(),
      })
      .overrideProvider(BotOrchestratorService)
      .useValue({
        onApplicationBootstrap: jest.fn().mockResolvedValue(undefined),
      })
      .compile();
  }

  it('compiles with development nodeEnv (pino pretty branch)', async () => {
    const moduleRef = await compileWithNodeEnv('development');
    expect(moduleRef.get(ConfigModule)).toBeDefined();
    await moduleRef.close();
  });

  it('compiles with production nodeEnv (no pino transport)', async () => {
    const moduleRef = await compileWithNodeEnv('production');
    expect(moduleRef.get(ConfigModule)).toBeDefined();
    await moduleRef.close();
  });
});
