import { Module } from '@nestjs/common';
import { DisputesModule } from '../disputes/disputes.module';
import { TelegramModule } from '../telegram/telegram.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [DisputesModule, TelegramModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
