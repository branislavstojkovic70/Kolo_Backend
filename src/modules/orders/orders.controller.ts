import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
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
import { CreateOrderDto } from './dto/create-order.dto';
import { QueryOrdersDto } from './dto/query-orders.dto';
import { OrdersService } from './orders.service';

@ApiTags('orders')
@ApiAuth()
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @ApiOperation({
    summary: 'Buy a listing — creates the order and an OxaPay invoice',
    description:
      'Snapshots the listing title and price, splits the price into `feeUsd` + ' +
      '`sellerAmountUsd`, then asks OxaPay for an invoice. Send the buyer to `paymentUrl`. ' +
      'The order stays `PENDING_PAYMENT` until the OxaPay webhook confirms payment — ' +
      'that webhook is what sets `paidAt` and `vestedAt`. ' +
      'You cannot buy your own listing.',
  })
  @ApiCreatedResponse({
    description: 'Order created, invoice ready',
    schema: { example: EX.ORDER_CREATED },
  })
  @ApiBadRequestResponse({
    description: 'Buying your own listing',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Listing missing or not ACTIVE',
    type: ErrorResponseDto,
  })
  @ApiBadGatewayResponse({
    description: 'OxaPay refused the invoice. The order row still exists.',
    type: ErrorResponseDto,
  })
  create(@CurrentUser() user: User, @Body() dto: CreateOrderDto) {
    return this.orders.create(user.id, dto.listingId);
  }

  @Get()
  @ApiOperation({
    summary: 'My orders — both sides, one paginated list',
    description:
      'Newest first. `role` picks the side (`all` by default, or `buying` / `selling`), ' +
      '`search` matches the snapshotted title and `status` filters by order status. ' +
      'Use this instead of merging `/purchases` and `/sales`: two paginated lists cannot ' +
      'be combined into one page. Never includes `deliveryInfo`.',
  })
  @ApiOkResponse({
    description: 'My orders',
    schema: { example: EX.ORDER_PAGE },
  })
  findAll(@CurrentUser() user: User, @Query() query: QueryOrdersDto) {
    return this.orders.findAll(user.id, query);
  }

  @Get('purchases')
  @ApiOperation({
    summary: 'Orders I placed',
    description:
      'Newest first, paginated. Optional `search` matches the snapshotted title, ' +
      '`status` filters by order status. Never includes `deliveryInfo` — fetch the ' +
      'single order for that.',
  })
  @ApiOkResponse({
    description: 'My purchases',
    schema: { example: EX.ORDER_PAGE },
  })
  purchases(@CurrentUser() user: User, @Query() query: QueryOrdersDto) {
    return this.orders.findPurchases(user.id, query);
  }

  @Get('sales')
  @ApiOperation({
    summary: 'Orders on my listings',
    description:
      'Newest first, paginated, same `search` / `status` filters as purchases. ' +
      '`sellerAmountUsd` is what lands in escrow for me.',
  })
  @ApiOkResponse({
    description: 'My sales',
    schema: { example: EX.ORDER_PAGE },
  })
  sales(@CurrentUser() user: User, @Query() query: QueryOrdersDto) {
    return this.orders.findSales(user.id, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Order detail (buyer or seller only)',
    description:
      'The **only** endpoint that can return `deliveryInfo`, and only when the caller is the ' +
      '**buyer** and the order is `PAID`, `DISPUTED` or `REFUNDED`. For everyone else the ' +
      'field is absent from the response entirely.',
  })
  @ApiParam({ name: 'id', example: 'ord_vesting_1' })
  @ApiOkResponse({
    description: 'The order — `deliveryInfo` present only for the paid buyer',
    schema: { example: EX.ORDER_DETAIL },
  })
  @ApiForbiddenResponse({
    description: 'Neither buyer nor seller',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({ description: 'No such order', type: ErrorResponseDto })
  findOne(@CurrentUser() user: User, @Param('id') id: string) {
    return this.orders.findOne(id, user.id);
  }
}
