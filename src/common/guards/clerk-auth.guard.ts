import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { createClerkClient, verifyToken } from '@clerk/backend';
import { Role, User } from '@prisma/client';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ClerkAuthGuard implements CanActivate {
  private readonly logger = new Logger(ClerkAuthGuard.name);
  private readonly clerk: ReturnType<typeof createClerkClient>;

  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.clerk = createClerkClient({
      secretKey: this.config.get<string>('clerk.secretKey'),
    });
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();

    const devUser = await this.tryDevBypass(req);
    if (devUser) {
      req.user = devUser;
      return true;
    }

    const auth: string | undefined = req.headers['authorization'];
    if (!auth?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = auth.slice('Bearer '.length).trim();

    let payload: any;
    try {
      payload = await verifyToken(token, {
        secretKey: this.config.get<string>('clerk.secretKey'),
      });
    } catch (e) {
      this.logger.warn(`Token verification failed: ${e?.message}`);
      throw new UnauthorizedException('Invalid token');
    }

    const clerkUserId: string = payload.sub;
    if (!clerkUserId) throw new UnauthorizedException('Token has no subject');

    req.user = await this.provision(clerkUserId, payload);
    return true;
  }

  /**
   * JIT provisioning. Email may live in the token claims; if it doesn't we hit the
   * Clerk API — but only when the row doesn't exist yet, never on every request.
   */
  private async provision(clerkUserId: string, payload: any): Promise<User> {
    const existing = await this.prisma.user.findUnique({
      where: { clerkUserId },
    });

    if (existing) {
      const role = this.roleFor(existing.email, existing.role);
      // Rows adopted from the seed may predate the Clerk profile — backfill
      // the avatar/name from Clerk once; after that this path never hits the API.
      const needsBackfill = !existing.imageUrl || !existing.username;
      if (role === existing.role && !needsBackfill) return existing;

      let { username, imageUrl } = existing;
      if (needsBackfill) {
        const clerkUser = await this.clerk.users.getUser(clerkUserId);
        username =
          username ||
          clerkUser.username ||
          [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') ||
          null;
        imageUrl = imageUrl || clerkUser.imageUrl || null;
      }
      return this.prisma.user.update({
        where: { id: existing.id },
        data: { role, username, imageUrl },
      });
    }

    let email: string | undefined =
      payload.email ?? payload.email_address ?? payload.primary_email_address;
    let username: string | undefined = payload.username ?? payload.name;
    let imageUrl: string | undefined = payload.image_url ?? payload.picture;

    if (!email) {
      // create-only fallback
      const clerkUser = await this.clerk.users.getUser(clerkUserId);
      email =
        clerkUser.emailAddresses.find(
          (e) => e.id === clerkUser.primaryEmailAddressId,
        )?.emailAddress ?? clerkUser.emailAddresses[0]?.emailAddress;
      username =
        username ??
        clerkUser.username ??
        [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') ??
        undefined;
      imageUrl = imageUrl ?? clerkUser.imageUrl;
    }

    if (!email)
      throw new UnauthorizedException(
        'Could not resolve an email for this account',
      );

    return this.linkOrCreate(clerkUserId, email, {
      username: username || null,
      imageUrl: imageUrl || null,
    });
  }

  /**
   * Creates the user, or adopts an existing row that already owns this email
   * (seeded accounts, or a dev-bypass row later replaced by a real Clerk login).
   * Without this the unique email constraint would 500 on first real login.
   */
  private async linkOrCreate(
    clerkUserId: string,
    email: string,
    extras: { username?: string | null; imageUrl?: string | null } = {},
  ): Promise<User> {
    const normalized = email.toLowerCase();
    const role = this.roleFor(normalized, Role.USER);

    const byEmail = await this.prisma.user.findUnique({
      where: { email: normalized },
    });
    if (byEmail) {
      return this.prisma.user.update({
        where: { id: byEmail.id },
        data: {
          clerkUserId,
          role: role === Role.ADMIN ? Role.ADMIN : byEmail.role,
          // The live Clerk profile (Google photo, real name) beats whatever
          // the seed or a dev-bypass session wrote into the adopted row.
          username: extras.username ?? byEmail.username ?? undefined,
          imageUrl: extras.imageUrl ?? byEmail.imageUrl ?? undefined,
        },
      });
    }

    return this.prisma.user.upsert({
      where: { clerkUserId },
      update: { role },
      create: {
        clerkUserId,
        email: normalized,
        username: extras.username ?? normalized.split('@')[0],
        imageUrl: extras.imageUrl ?? null,
        role,
      },
    });
  }

  private roleFor(email: string, current: Role): Role {
    const admins = this.config.get<string[]>('adminEmails') ?? [];
    return admins.includes(email.toLowerCase()) ? Role.ADMIN : current;
  }

  /**
   * DEV ONLY: accept `x-dev-user-email` instead of a Clerk token so the API can be
   * driven before the frontend exists. Never active in production.
   */
  private async tryDevBypass(req: any): Promise<User | null> {
    const enabled =
      process.env.NODE_ENV !== 'production' &&
      process.env.DEV_AUTH_BYPASS === 'true';
    if (!enabled) return null;

    const raw = req.headers['x-dev-user-email'];
    const email = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase();
    if (!email) return null;

    this.logger.warn(
      `*** DEV AUTH BYPASS *** ${req.method} ${req.url} authenticated as "${email}" with no token`,
    );

    return this.linkOrCreate(`dev_${email}`, email);
  }
}
