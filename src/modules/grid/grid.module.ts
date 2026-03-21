import { Module } from '@nestjs/common';
import { GridService } from './grid.service.js';
import { ExchangeModule } from '../exchange/exchange.module.js';
import { PrismaService } from '../../prisma.service.js';

@Module({
  imports: [ExchangeModule],
  providers: [GridService, PrismaService],
  exports: [GridService],
})
export class GridModule {}
