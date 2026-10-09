import { timingSafeEqual } from 'node:crypto';
import {
  Controller,
  Get,
  Headers,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { AutoBuyService } from './auto-buy.service';

/**
 * HTTP trigger for the auto-buy cleanup sweep. On serverless hosts (Vercel) the
 * in-process @Cron never fires between requests, so an external scheduler calls
 * this every minute with `Authorization: Bearer $CRON_SECRET` — the same header
 * Vercel Cron sends. Disabled (401) when CRON_SECRET is unset.
 */
@ApiExcludeController()
@Controller('cron')
export class AutoBuyCronController {
  constructor(private readonly autoBuy: AutoBuyService) {}

  @Public()
  @Get('auto-buy')
  async run(@Headers('authorization') authorization?: string) {
    const secret = process.env.CRON_SECRET;
    const expected = Buffer.from(`Bearer ${secret}`);
    const given = Buffer.from(authorization ?? '');
    if (
      !secret ||
      given.length !== expected.length ||
      !timingSafeEqual(given, expected)
    ) {
      throw new UnauthorizedException('Invalid cron secret');
    }

    await this.autoBuy.cleanup();
    return { ok: true };
  }
}
