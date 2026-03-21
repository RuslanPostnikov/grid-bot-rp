import { Module } from '@nestjs/common';
import { ClaudeService } from './claude.service.js';
import { ExchangeModule } from '../exchange/exchange.module.js';
import { GridModule } from '../grid/grid.module.js';
import { RiskModule } from '../risk/risk.module.js';
import { PrismaService } from '../../prisma.service.js';

@Module({
  imports: [ExchangeModule, GridModule, RiskModule],
  providers: [ClaudeService, PrismaService],
  exports: [ClaudeService],
})
export class ClaudeModule {}
