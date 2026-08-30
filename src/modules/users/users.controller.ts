import { Body, Controller, Get, Patch } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { User } from '@prisma/client';
import { ApiAuth } from '../../common/decorators/api-auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ErrorResponseDto } from '../../common/dto/error-response.dto';
import * as EX from '../../common/swagger/examples';
import { UpdateMeDto } from './dto/update-me.dto';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiAuth()
@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  @ApiOperation({
    summary: 'Current user',
    description:
      'Returns the caller. The row is created on the first authenticated request (JIT ' +
      'provisioning from the Clerk token) — there is no separate sign-up call. `role` is ' +
      "`ADMIN` when the e-mail is listed in the server's `ADMIN_EMAILS`.",
  })
  @ApiOkResponse({ description: 'The caller', schema: { example: EX.ME } })
  me(@CurrentUser() user: User) {
    return this.users.toPublic(user);
  }

  @Patch('me')
  @ApiOperation({
    summary: 'Update own profile',
    description:
      'Both fields are optional; omitted fields are left untouched. `telegramUsername` is ' +
      "informational only — it is shown in the dispute group's opening message and is never " +
      'used to add anyone to a Telegram group.',
  })
  @ApiOkResponse({
    description: 'The updated user',
    schema: { example: EX.ME },
  })
  @ApiBadRequestResponse({
    description: 'Validation failed',
    type: ErrorResponseDto,
  })
  updateMe(@CurrentUser() user: User, @Body() dto: UpdateMeDto) {
    return this.users.updateMe(user.id, dto);
  }
}
