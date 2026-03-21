import { Module } from '@nestjs/common';
import { MlService } from './ml.service.js';
import { PrismaService } from '../../prisma.service.js';

@Module({
  providers: [MlService, PrismaService],
  exports: [MlService],
})
export class MlModule {}
