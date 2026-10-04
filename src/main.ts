import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { DEV_BYPASS_SCHEME } from './common/decorators/api-auth.decorator';

const DESCRIPTION = `
Escrow marketplace for digital services. A buyer pays in crypto through OxaPay to the
platform's merchant account; the money is held in escrow for a **vesting period**
(\`VESTING_DAYS\`, default 30) before the seller can withdraw it to their own wallet.
A buyer can open a **dispute**, which freezes the funds and opens a Telegram group with
an admin; whoever wins the dispute becomes the beneficiary of the money.

### Conventions — the same everywhere

| | |
|---|---|
| **Money** | Always a **string with 2 decimals** (\`"24.99"\`). Never a float. All amounts are USD. |
| **Timestamps** | Always **ISO-8601 UTC** (\`"2026-08-30T09:12:44.000Z"\`) or \`null\`. |
| **Errors** | Always \`{ statusCode, message, error }\`. \`message\` is always a single displayable string. |
| **Auth** | \`401\` unless the endpoint is marked public. |
| **deliveryInfo** | Returned by exactly one endpoint — \`GET /api/orders/{id}\` — and only for the **buyer** of an order that is \`PAID\`, \`DISPUTED\` or \`REFUNDED\`. |

### Authenticating from this page

Click **Authorize** (top right). You get two options:

1. **bearer** — a Clerk session JWT from the frontend. Production path.
2. **${DEV_BYPASS_SCHEME}** — put an *e-mail address* in the box. It is sent as the
   \`x-dev-user-email\` header and the API logs you in as that user, creating them on the
   spot if needed. No token, no Clerk, no frontend required.

The bypass only works when the server runs with \`DEV_AUTH_BYPASS=true\` and
\`NODE_ENV !== 'production'\`, and every bypassed request is logged with a loud warning.
Seeded accounts to try (see \`npx prisma db seed\` output):

\`\`\`
elena.petrova@example.com   seller — money in every balance bucket
marcus.reid@example.com     seller — one clean payout ready to withdraw
tom.becker@example.com      buyer  — two unpaid invoices
me@example.com              admin  — whatever is in ADMIN_EMAILS
\`\`\`

curl equivalent:

\`\`\`
curl http://localhost:3000/api/wallet/balance -H "x-dev-user-email: elena.petrova@example.com"
\`\`\`
`;

async function bootstrap() {
  // rawBody is required for OxaPay webhook HMAC verification
  const app = await NestFactory.create(AppModule, { rawBody: true });

  app.setGlobalPrefix('api');
  app.enableCors({ origin: true, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  // One error shape for the whole API: { statusCode, message, error }
  app.useGlobalFilters(new AllExceptionsFilter());

  const config = new DocumentBuilder()
    .setTitle('Digital Services Marketplace API')
    .setDescription(DESCRIPTION)
    .setVersion('1.0')
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description:
        'Clerk session JWT — paste the token, without the "Bearer " prefix.',
    })
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'x-dev-user-email',
        description:
          'DEV ONLY. Put an e-mail address here to be authenticated as that user without a ' +
          'Clerk token. Requires DEV_AUTH_BYPASS=true on the server.',
      },
      DEV_BYPASS_SCHEME,
    )
    .addTag(
      'users',
      'Who am I. The account is created on the first authenticated request.',
    )
    .addTag(
      'products',
      'The predefined product catalog. A listing can only sell one of these; ' +
        '`retailPriceUsd` is the official price the seller undercuts.',
    )
    .addTag(
      'listings',
      'The marketplace catalogue. Browsing is public; writing is owner-only. ' +
        'Every listing points at a catalog product — title and category come from it.',
    )
    .addTag(
      'orders',
      'Buying: order + OxaPay invoice, then the buyer-facing order views.',
    )
    .addTag(
      'stats',
      'Buyer savings vs. retail, computed from the price snapshot taken at purchase time.',
    )
    .addTag(
      'wallet',
      'Escrow balances and payouts. "available" means orders that individually passed ' +
        'their own vesting date, are undisputed, and are not already linked to a withdrawal.',
    )
    .addTag(
      'disputes',
      'Buyer-opened disputes and the Telegram group that goes with them.',
    )
    .addTag(
      'admin',
      'Admin-only: resolve disputes, inspect orders and withdrawals, stats.',
    )
    .addTag(
      'webhooks',
      'OxaPay server-to-server callbacks. Public, HMAC-signed, raw body — listed for reference; ' +
        'they cannot be exercised from this page.',
    )
    .addTag('health', 'Liveness and database check.')
    .build();

  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config), {
    swaggerOptions: {
      persistAuthorization: true,
      docExpansion: 'list',
      tagsSorter: 'alpha',
    },
    customSiteTitle: 'Marketplace API — docs',
  });

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  new Logger('Bootstrap').log(
    `API on http://localhost:${port}/api — docs at /docs`,
  );
}
bootstrap();
