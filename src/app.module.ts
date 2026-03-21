import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import configuration from './config/configuration.js';
import { PrismaService } from './prisma.service.js';
import { ExchangeModule } from './modules/exchange/exchange.module.js';
import { CollectorModule } from './modules/collector/collector.module.js';
import { GridModule } from './modules/grid/grid.module.js';
import { MlModule } from './modules/ml/ml.module.js';
import { RiskModule } from './modules/risk/risk.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    ScheduleModule.forRoot(),
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
  ],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class AppModule {}
