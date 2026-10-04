import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import * as EX from '../../common/swagger/examples';
import { ProductsService } from './products.service';

@ApiTags('products')
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Public()
  @Get()
  @ApiOperation({
    summary: 'The product catalog (public, no token needed)',
    description:
      'Every active catalog product, sorted by category then name. A listing can only ' +
      'be created for one of these — this feeds the "create listing" dropdown and shows ' +
      'the official retail price (`retailPriceUsd`) the seller undercuts.',
  })
  @ApiOkResponse({
    description: 'Active products',
    schema: { example: EX.PRODUCT_LIST },
  })
  findAll() {
    return this.products.findActive();
  }
}
