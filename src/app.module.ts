import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD } from '@nestjs/core';
import configuration from './config/configuration';
import { validateEnv } from './config/env.validation';
import { ClerkAuthGuard } from './common/guards/clerk-auth.guard';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './modules/health/health.module';
import { PlatformConfigModule } from './modules/config/config.module';
import { UsersModule } from './modules/users/users.module';
import { ListingsModule } from './modules/listings/listings.module';
import { ProductsModule } from './modules/products/products.module';
import { StatsModule } from './modules/stats/stats.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { TelegramModule } from './modules/telegram/telegram.module';
import { DisputesModule } from './modules/disputes/disputes.module';
import { AdminModule } from './modules/admin/admin.module';
import { BuyRequestsModule } from './modules/buy-requests/buy-requests.module';
import { DevModule } from './modules/dev/dev.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),
    // only the auto-buy cleanup cron uses this
    ScheduleModule.forRoot(),
    PrismaModule,
    HealthModule,
    PlatformConfigModule,
    UsersModule,
    ProductsModule,
    ListingsModule,
    OrdersModule,
    BuyRequestsModule,
    StatsModule,
    PaymentsModule,
    WalletModule,
    TelegramModule,
    DisputesModule,
    AdminModule,
    ...DevModule.registerIfEnabled(),
  ],
  providers: [{ provide: APP_GUARD, useClass: ClerkAuthGuard }],
})
export class AppModule {}
