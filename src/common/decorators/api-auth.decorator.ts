import { applyDecorators } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiSecurity,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../dto/error-response.dto';

/** The name of the dev-bypass header scheme registered in main.ts. */
export const DEV_BYPASS_SCHEME = 'dev-bypass';

/**
 * Marks an endpoint as authenticated in Swagger: a Clerk bearer token, or — when
 * DEV_AUTH_BYPASS=true — the `x-dev-user-email` header. Both appear in the Authorize
 * dialog, so the FE team can drive the whole API from /docs before Clerk is wired up.
 */
export const ApiAuth = () =>
  applyDecorators(
    ApiBearerAuth(),
    ApiSecurity(DEV_BYPASS_SCHEME),
    ApiUnauthorizedResponse({
      description: 'No valid Clerk token (and no dev-bypass header)',
      type: ErrorResponseDto,
    }),
  );
