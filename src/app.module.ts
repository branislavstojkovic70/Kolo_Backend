import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import configuration from './config/configuration';
import { validateEnv } from './config/env.validation';
import { ClerkAuthGuard } from './common/guards/clerk-auth.guard';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './modules/health/health.module';
import { UsersModule } from './modules/users/users.module';
import { ListingsModule } from './modules/listings/listings.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { TelegramModule } from './modules/telegram/telegram.module';
import { DisputesModule } from './modules/disputes/disputes.module';
import { AdminModule } from './modules/admin/admin.module';
import { DevModule } from './modules/dev/dev.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),
    PrismaModule,
    HealthModule,
    UsersModule,
    ListingsModule,
    OrdersModule,
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
