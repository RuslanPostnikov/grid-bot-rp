import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import type { DynamicModule, Type } from '@nestjs/common';
import configuration from '../src/config/configuration.js';

/** Nest globals required by feature modules when tested outside AppModule. */
export function globalTestImports(
  ...featureModules: Array<Type<unknown> | DynamicModule>
): Array<Type<unknown> | DynamicModule> {
  return [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    ...featureModules,
  ];
}
