import { Module } from '@nestjs/common';
import { RiskService } from './risk.service.js';
import { ExchangeModule } from '../exchange/exchange.module.js';
import { GridModule } from '../grid/grid.module.js';
import { PrismaService } from '../../prisma.service.js';

@Module({
  imports: [ExchangeModule, GridModule],
  providers: [RiskService, PrismaService],
  exports: [RiskService],
})
export class RiskModule {}
