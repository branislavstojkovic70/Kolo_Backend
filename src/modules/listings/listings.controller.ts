import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
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
import { Public } from '../../common/decorators/public.decorator';
import { ErrorResponseDto } from '../../common/dto/error-response.dto';
import * as EX from '../../common/swagger/examples';
import { CreateListingDto } from './dto/create-listing.dto';
import { QueryListingsDto } from './dto/query-listings.dto';
import { UpdateListingDto } from './dto/update-listing.dto';
import { ListingsService } from './listings.service';

@ApiTags('listings')
@Controller('listings')
export class ListingsController {
  constructor(private readonly listings: ListingsService) {}

  @Public()
  @Get()
  @ApiOperation({
    summary: 'Browse active listings (public, no token needed)',
    description:
      'Only `ACTIVE` listings, newest first. `search` matches the title case-insensitively, ' +
      '`category` is an exact case-insensitive match. `deliveryInfo` is never included.',
  })
  @ApiOkResponse({
    description: 'Paginated listings',
    schema: { example: EX.LISTING_PAGE },
  })
  findAll(@Query() q: QueryListingsDto) {
    return this.listings.findPublic(q);
  }

  // must stay above :id so "mine" isn't swallowed as an id
  @Public()
  @Get('stats')
  @ApiOperation({
    summary: 'Marketplace headline numbers (public)',
    description:
      'Counted over `ACTIVE` listings in the database, not over one page of results — ' +
      'the FE must not average a page and call it a catalogue median.',
  })
  @ApiOkResponse({
    description: 'Catalogue stats',
    schema: { example: EX.LISTING_STATS },
  })
  stats() {
    return this.listings.stats();
  }

  @Get('mine')
  @ApiAuth()
  @ApiOperation({
    summary: 'My listings',
    description:
      'Everything I sell except soft-deleted rows, paginated. Includes `PAUSED` ' +
      'listings, and takes the same `search` / `category` / price / `sort` filters ' +
      'as the public feed.',
  })
  @ApiOkResponse({
    description: 'My listings',
    schema: { example: EX.LISTING_PAGE },
  })
  findMine(@CurrentUser() user: User, @Query() q: QueryListingsDto) {
    return this.listings.findMine(user.id, q);
  }

  @Public()
  @Get(':id')
  @ApiOperation({
    summary: 'Listing detail (public, no token needed)',
    description:
      'Soft-deleted listings return 404. `deliveryInfo` is never included.',
  })
  @ApiParam({ name: 'id', example: 'lst_youtube' })
  @ApiOkResponse({
    description: 'The listing',
    schema: { example: EX.LISTING },
  })
  @ApiNotFoundResponse({
    description: 'No such listing',
    type: ErrorResponseDto,
  })
  findOne(@Param('id') id: string) {
    return this.listings.findOnePublic(id);
  }

  @Post()
  @ApiAuth()
  @ApiOperation({
    summary: 'Create a listing',
    description:
      '`productId` must be an active catalog product (GET /api/products) — the listing ' +
      'title and category are copied from it; an unknown or inactive product is a 400. ' +
      '`priceUsd` is a number with at most 2 decimals; it comes back as a 2-decimal string. ' +
      '`deliveryInfo` (credentials, redeem codes, instructions) is stored but is only ever ' +
      'revealed to the buyer of a paid order.',
  })
  @ApiCreatedResponse({
    description: 'The new listing',
    schema: { example: EX.LISTING },
  })
  @ApiBadRequestResponse({
    description: 'Validation failed',
    type: ErrorResponseDto,
  })
  create(@CurrentUser() user: User, @Body() dto: CreateListingDto) {
    return this.listings.create(user.id, dto);
  }

  @Patch(':id')
  @ApiAuth()
  @ApiOperation({
    summary: 'Update a listing (owner only)',
    description:
      'Every field is optional; omitted fields are untouched. `productId` cannot be changed — ' +
      'title and category always mirror the catalog product. `status` may be set to `ACTIVE` ' +
      'or `PAUSED` — use DELETE to soft-delete.',
  })
  @ApiParam({ name: 'id', example: 'lst_youtube' })
  @ApiOkResponse({
    description: 'The updated listing',
    schema: { example: EX.LISTING },
  })
  @ApiForbiddenResponse({
    description: 'Not your listing',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'No such listing',
    type: ErrorResponseDto,
  })
  update(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: UpdateListingDto,
  ) {
    return this.listings.update(id, user.id, dto);
  }

  @Delete(':id')
  @ApiAuth()
  @ApiOperation({
    summary: 'Soft-delete a listing (owner only)',
    description:
      'Sets status to `DELETED`. Nothing is removed from the database — existing orders keep ' +
      'their title snapshot and their delivery info.',
  })
  @ApiParam({ name: 'id', example: 'lst_youtube' })
  @ApiOkResponse({
    description: 'Deleted',
    schema: { example: EX.LISTING_DELETED },
  })
  @ApiForbiddenResponse({
    description: 'Not your listing',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'No such listing',
    type: ErrorResponseDto,
  })
  remove(@CurrentUser() user: User, @Param('id') id: string) {
    return this.listings.remove(id, user.id);
  }
}
