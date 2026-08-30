import { DynamicModule, Logger, Module } from '@nestjs/common';
import { DevController } from './dev.controller';

@Module({})
export class DevModule {
  /** Mounted only in mock/dev mode, and never in production. */
  static registerIfEnabled(): DynamicModule[] {
    const enabled =
      process.env.NODE_ENV !== 'production' &&
      (process.env.OXAPAY_MOCK === 'true' ||
        process.env.DEV_AUTH_BYPASS === 'true');

    if (!enabled) return [];

    new Logger(DevModule.name).warn(
      '*** DEV PAYMENT SIMULATOR MOUNTED at /api/dev/mock-pay/:orderId — never enable in production ***',
    );
    return [{ module: DevModule, controllers: [DevController] }];
  }
}
