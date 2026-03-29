import { Test } from '@nestjs/testing';
import { globalTestImports } from '../../../global-test-imports.js';
import { PrismaService } from '@src/prisma.service.js';
import { createMockPrisma } from '../../../test-utils/mocks.js';
import { RiskModule } from '@src/modules/risk/risk.module.js';
import { RiskService } from '@src/modules/risk/risk.service.js';

describe('RiskModule', () => {
  it('compiles and exposes RiskService', async () => {
    const module = await Test.createTestingModule({
      imports: globalTestImports(RiskModule),
    })
      .overrideProvider(PrismaService)
      .useValue(createMockPrisma())
      .compile();
    expect(module.get(RiskService)).toBeInstanceOf(RiskService);
  });
});
