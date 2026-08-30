import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { User } from '@prisma/client';

/** Resolves the DB user attached by ClerkAuthGuard. */
export const CurrentUser = createParamDecorator(
  (data: keyof User | undefined, ctx: ExecutionContext) => {
    const user: User = ctx.switchToHttp().getRequest().user;
    return data ? user?.[data] : user;
  },
);
