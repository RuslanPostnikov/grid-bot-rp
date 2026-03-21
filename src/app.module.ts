import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import configuration from './config/configuration.js';
import { PrismaService } from './prisma.service.js';
import { ExchangeModule } from './modules/exchange/exchange.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
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
  ],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class AppModule {}
