import { Module } from '@nestjs/common';
import { TelegramService } from './telegram.service.js';
import { ExchangeModule } from '../exchange/exchange.module.js';
import { GridModule } from '../grid/grid.module.js';
import { RiskModule } from '../risk/risk.module.js';
import { ClaudeModule } from '../claude/claude.module.js';
import { PrismaService } from '../../prisma.service.js';

@Module({
  imports: [ExchangeModule, GridModule, RiskModule, ClaudeModule],
  providers: [TelegramService, PrismaService],
  exports: [TelegramService],
})
export class TelegramModule {}
