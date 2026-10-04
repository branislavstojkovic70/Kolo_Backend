import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
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
import { BuyRequestsService } from './buy-requests.service';
import { CreateBuyRequestDto } from './dto/create-buy-request.dto';
import { QueryBuyRequestsDto } from './dto/query-buy-requests.dto';

@ApiTags('buy-requests')
@ApiAuth()
@Controller('buy-requests')
export class BuyRequestsController {
  constructor(private readonly buyRequests: BuyRequestsService) {}

  @Post()
  @ApiOperation({
    summary: 'Register a standing wish: auto-buy a product at or below a price',
    description:
      'If a qualifying listing **already exists**, the match fires immediately: the response ' +
      'comes back `MATCHED` with a `matchedOrder` carrying the payment link, and the listing is ' +
      'reserved for you for `autoBuyReservationMinutes` (GET /api/config). Otherwise the request ' +
      'stays `ACTIVE` and fires the moment a seller lists the product at or under `maxPriceUsd`. ' +
      'You pay the OxaPay invoice yourself either way — nothing is charged up front. ' +
      'One ACTIVE request per product per buyer.',
  })
  @ApiCreatedResponse({
    description: 'The request — possibly already MATCHED with a payment link',
    schema: { example: EX.BUY_REQUEST_MATCHED },
  })
  @ApiBadRequestResponse({
    description: 'Unknown/inactive product or non-positive price',
    type: ErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'You already have an ACTIVE request for this product',
    type: ErrorResponseDto,
  })
  create(@CurrentUser() user: User, @Body() dto: CreateBuyRequestDto) {
    return this.buyRequests.create(user.id, dto);
  }

  // must stay above :id so "mine" isn't swallowed as an id
  @Get('mine')
  @ApiOperation({
    summary: 'My buy requests',
    description:
      'Newest first, paginated, optional `?status=` filter. Each row embeds the product and, ' +
      'for `MATCHED` ones, the pending order (id, amount, `paymentUrl`) so the UI can show ' +
      '"your wish matched — pay now".',
  })
  @ApiOkResponse({
    description: 'Paginated buy requests',
    schema: { example: EX.BUY_REQUEST_PAGE },
  })
  findMine(@CurrentUser() user: User, @Query() q: QueryBuyRequestsDto) {
    return this.buyRequests.findMine(user.id, q);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Buy request detail (owner or admin only)' })
  @ApiParam({ name: 'id', example: 'breq_active_1' })
  @ApiOkResponse({
    description: 'The buy request',
    schema: { example: EX.BUY_REQUEST_MATCHED },
  })
  @ApiForbiddenResponse({
    description: 'Not your request and you are not an admin',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'No such buy request',
    type: ErrorResponseDto,
  })
  findOne(@CurrentUser() user: User, @Param('id') id: string) {
    return this.buyRequests.findOne(id, user);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Cancel an ACTIVE buy request (owner only)',
    description:
      'Only `ACTIVE` requests can be cancelled. A `MATCHED` one already has an order awaiting ' +
      'payment — just don’t pay it; everything resets when the reservation expires.',
  })
  @ApiParam({ name: 'id', example: 'breq_active_1' })
  @ApiOkResponse({
    description: 'The cancelled request',
    schema: { example: EX.BUY_REQUEST_CANCELLED },
  })
  @ApiConflictResponse({
    description: 'Already MATCHED (or otherwise not ACTIVE)',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'Not your request',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'No such buy request',
    type: ErrorResponseDto,
  })
  cancel(@CurrentUser() user: User, @Param('id') id: string) {
    return this.buyRequests.cancel(id, user.id);
  }
}
