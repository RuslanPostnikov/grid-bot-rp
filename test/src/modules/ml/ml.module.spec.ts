import { Test } from '@nestjs/testing';
import { globalTestImports } from '../../../global-test-imports.js';
import { MlModule } from '@src/modules/ml/ml.module.js';
import { MlService } from '@src/modules/ml/ml.service.js';

describe('MlModule', () => {
  it('compiles and exposes MlService', async () => {
    const module = await Test.createTestingModule({
      imports: globalTestImports(MlModule),
    }).compile();
    expect(module.get(MlService)).toBeInstanceOf(MlService);
  });
});
