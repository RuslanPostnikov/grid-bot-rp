import { Test } from '@nestjs/testing';
import { globalTestImports } from '../../../global-test-imports.js';
import { ExchangeModule } from '@src/modules/exchange/exchange.module.js';
import { ExchangeService } from '@src/modules/exchange/exchange.service.js';

describe('ExchangeModule', () => {
  it('compiles and exposes ExchangeService', async () => {
    const module = await Test.createTestingModule({
      imports: globalTestImports(ExchangeModule),
    }).compile();
    expect(module.get(ExchangeService)).toBeInstanceOf(ExchangeService);
  });
});
