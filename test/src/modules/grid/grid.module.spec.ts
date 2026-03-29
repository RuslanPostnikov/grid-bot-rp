import { Test } from '@nestjs/testing';
import { globalTestImports } from '../../../global-test-imports.js';
import { PrismaService } from '@src/prisma.service.js';
import { createMockPrisma } from '../../../test-utils/mocks.js';
import { GridModule } from '@src/modules/grid/grid.module.js';
import { GridService } from '@src/modules/grid/grid.service.js';

describe('GridModule', () => {
  it('compiles and exposes GridService', async () => {
    const module = await Test.createTestingModule({
      imports: globalTestImports(GridModule),
    })
      .overrideProvider(PrismaService)
      .useValue(createMockPrisma())
      .compile();
    expect(module.get(GridService)).toBeInstanceOf(GridService);
  });
});
