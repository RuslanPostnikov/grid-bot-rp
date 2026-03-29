import { Test } from '@nestjs/testing';
import { globalTestImports } from '../../../global-test-imports.js';
import { PrismaService } from '@src/prisma.service.js';
import { createMockPrisma } from '../../../test-utils/mocks.js';
import { ClaudeModule } from '@src/modules/claude/claude.module.js';
import { ClaudeService } from '@src/modules/claude/claude.service.js';

describe('ClaudeModule', () => {
  it('compiles and exposes ClaudeService', async () => {
    const module = await Test.createTestingModule({
      imports: globalTestImports(ClaudeModule),
    })
      .overrideProvider(PrismaService)
      .useValue(createMockPrisma())
      .compile();
    expect(module.get(ClaudeService)).toBeInstanceOf(ClaudeService);
  });
});
