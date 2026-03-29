import { Test } from '@nestjs/testing';
import { globalTestImports } from '../../../global-test-imports.js';
import { PrismaService } from '@src/prisma.service.js';
import { createMockPrisma } from '../../../test-utils/mocks.js';
import { TelegramModule } from '@src/modules/telegram/telegram.module.js';
import { TelegramService } from '@src/modules/telegram/telegram.service.js';

describe('TelegramModule', () => {
  it('compiles and exposes TelegramService', async () => {
    const module = await Test.createTestingModule({
      imports: globalTestImports(TelegramModule),
    })
      .overrideProvider(PrismaService)
      .useValue(createMockPrisma())
      .compile();
    expect(module.get(TelegramService)).toBeInstanceOf(TelegramService);
  });
});
