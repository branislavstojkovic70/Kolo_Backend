import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import * as EX from '../../common/swagger/examples';
import { PrismaService } from '../../prisma/prisma.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  @ApiOperation({
    summary: 'Liveness + database check (public)',
    description:
      'Always `200` as long as the process is up. `db` is `"up"` or `"down"` depending on ' +
      'whether a trivial query succeeds — check that field, not just the status code.',
  })
  @ApiOkResponse({
    description: 'Service status',
    schema: { example: EX.HEALTH },
  })
  async health() {
    let db = 'down';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      db = 'up';
    } catch {
      db = 'down';
    }

    return { status: 'ok', db };
  }
}
