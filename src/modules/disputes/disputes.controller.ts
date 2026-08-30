import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { User } from '@prisma/client';
import { ApiAuth } from '../../common/decorators/api-auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ErrorResponseDto } from '../../common/dto/error-response.dto';
import * as EX from '../../common/swagger/examples';
import { CreateDisputeDto } from './dto/create-dispute.dto';
import { DisputesService } from './disputes.service';

@ApiTags('disputes')
@ApiAuth()
@Controller()
export class DisputesController {
  constructor(private readonly disputes: DisputesService) {}

  @Post('orders/:id/dispute')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Open a dispute (buyer only)',
    description: [
      'Only the **buyer**, only on an order that is `PAID`, only if no dispute exists yet,',
      'and only within `DISPUTE_WINDOW_DAYS` (default 30) of `paidAt`.',
      '',
      'The order flips to `DISPUTED` and its funds are frozen — the seller cannot withdraw',
      'even once vesting passes. A Telegram group is then created for the admins and the bot,',
      'and `telegramInviteLink` is how the buyer and the seller join it themselves.',
      '',
      'Telegram can never fail the dispute: if it is unconfigured or errors, the dispute is',
      'still created and `telegramInviteLink` comes back `null`. An admin can then call',
      '`POST /api/admin/disputes/{id}/telegram-retry`.',
    ].join('\n'),
  })
  @ApiParam({ name: 'id', description: 'Order id', example: 'ord_vesting_1' })
  @ApiCreatedResponse({
    description: 'Dispute opened. `telegramInviteLink` may be null.',
    schema: { example: EX.DISPUTE_CREATED },
  })
  @ApiBadRequestResponse({
    description: 'Order is not PAID, or the dispute window has closed',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'Caller is not the buyer',
    type: ErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'A dispute already exists',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({ description: 'No such order', type: ErrorResponseDto })
  create(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: CreateDisputeDto,
  ) {
    return this.disputes.create(id, user.id, dto);
  }

  @Get('disputes/mine')
  @ApiOperation({
    summary: 'Disputes where I am the buyer or the seller',
    description: 'Newest first, resolved ones included.',
  })
  @ApiOkResponse({
    description: 'My disputes',
    schema: { example: [EX.DISPUTE] },
  })
  mine(@CurrentUser() user: User) {
    return this.disputes.findMine(user.id);
  }

  @Get('disputes/:id')
  @ApiOperation({
    summary: 'Dispute detail (buyer, seller or admin)',
    description:
      'All three parties get `telegramInviteLink`, so the FE can render a "Join dispute chat" ' +
      'button on the order view for both the buyer and the seller.',
  })
  @ApiParam({ name: 'id', example: 'dsp_open_1' })
  @ApiOkResponse({
    description: 'The dispute',
    schema: { example: EX.DISPUTE },
  })
  @ApiForbiddenResponse({
    description: 'Not a party and not an admin',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'No such dispute',
    type: ErrorResponseDto,
  })
  findOne(@CurrentUser() user: User, @Param('id') id: string) {
    return this.disputes.findOne(id, user.id, user.role);
  }
}
