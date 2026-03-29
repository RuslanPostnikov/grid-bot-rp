import { Test } from '@nestjs/testing';
import { globalTestImports } from '../../../global-test-imports.js';
import { PrismaService } from '@src/prisma.service.js';
import { createMockPrisma } from '../../../test-utils/mocks.js';
import { CollectorModule } from '@src/modules/collector/collector.module.js';
import { CollectorService } from '@src/modules/collector/collector.service.js';

describe('CollectorModule', () => {
  it('compiles and exposes CollectorService', async () => {
    const module = await Test.createTestingModule({
      imports: globalTestImports(CollectorModule),
    })
      .overrideProvider(PrismaService)
      .useValue(createMockPrisma())
      .compile();
    expect(module.get(CollectorService)).toBeInstanceOf(CollectorService);
  });
});
