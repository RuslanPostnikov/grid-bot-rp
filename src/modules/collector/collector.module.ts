import { Module } from '@nestjs/common';
import { CollectorService } from './collector.service.js';
import { ExchangeModule } from '../exchange/exchange.module.js';
import { MlModule } from '../ml/ml.module.js';
import { PrismaService } from '../../prisma.service.js';

@Module({
  imports: [ExchangeModule, MlModule],
  providers: [CollectorService, PrismaService],
  exports: [CollectorService],
})
export class CollectorModule {}
