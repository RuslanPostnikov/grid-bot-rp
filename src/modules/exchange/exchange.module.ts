import { Module } from '@nestjs/common';
import { ExchangeService } from './exchange.service.js';

@Module({
  providers: [ExchangeService],
  exports: [ExchangeService],
})
export class ExchangeModule {}
