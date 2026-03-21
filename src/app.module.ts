import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { LoggerModule } from 'nestjs-pino';
import configuration from './config/configuration.js';
import { PrismaService } from './prisma.service.js';
import { ExchangeModule } from './modules/exchange/exchange.module.js';
import { CollectorModule } from './modules/collector/collector.module.js';
import { GridModule } from './modules/grid/grid.module.js';
import { MlModule } from './modules/ml/ml.module.js';
import { RiskModule } from './modules/risk/risk.module.js';
import { ClaudeModule } from './modules/claude/claude.module.js';
import { TelegramModule } from './modules/telegram/telegram.module.js';
import { BotOrchestratorService } from './bot-orchestrator.service.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: {
          transport:
            config.get('nodeEnv') === 'development'
              ? { target: 'pino-pretty', options: { colorize: true } }
              : undefined,
          level: config.get('nodeEnv') === 'development' ? 'debug' : 'info',
        },
      }),
    }),
    ExchangeModule,
    CollectorModule,
    GridModule,
    MlModule,
    RiskModule,
    ClaudeModule,
    TelegramModule,
  ],
  providers: [PrismaService, BotOrchestratorService],
  exports: [PrismaService],
})
export class AppModule {}
