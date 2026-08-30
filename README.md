# Digital Services Marketplace — Backend

A marketplace for digital services and accounts ("YouTube Premium, 12 months", "ChatGPT Plus,
1 month") where the **platform holds the money in escrow** instead of the buyer having to trust
the seller. Buyers pay in crypto, sellers get paid out to their own wallet, and an admin
arbitrates when something goes wrong.

NestJS 11 · PostgreSQL 16 · Prisma · Clerk · OxaPay · Telegram. REST API at `/api`,
interactive docs at **`/docs`**.

## The escrow model in five lines

1. A buyer pays a listing's price in crypto to **our** OxaPay merchant account, not to the seller.
2. On the paid webhook the order becomes `PAID` and gets a **vesting date**
   (`paidAt + VESTING_DAYS`, default 30 days), frozen at that moment and never recalculated.
3. Once an order passes *its own* vesting date the seller can withdraw it — no user wallet
   exists in the database, a balance is always derived from the orders themselves.
4. Within `DISPUTE_WINDOW_DAYS` the buyer can open a **dispute**: the order freezes even if it
   has vested, and a Telegram group is created for the buyer, the seller and an admin.
5. The admin picks a winner. Seller wins → back to `PAID`, original vesting clock untouched.
   Buyer wins → `REFUNDED`, the buyer becomes the beneficiary and can withdraw immediately.

Vesting is **per order**. A seller with three sales routinely has three different unlock dates,
and `POST /api/wallet/withdraw` pays out only the ones that have actually vested.

## Run it locally

Needs Node 20+ and Docker.

```bash
npm install
cp .env.example .env            # then fill it in — see the table below
docker compose up -d            # postgres:16 on :5432
npx prisma migrate deploy       # create the schema
npx prisma db seed              # demo data + a printed balance table
npm run start:dev
```

Then open **http://localhost:3000/docs**.

You do **not** need Clerk, OxaPay or Telegram credentials to run the whole thing. With
`DEV_AUTH_BYPASS=true` you authenticate by sending an e-mail address in the `x-dev-user-email`
header (there is a box for it under **Authorize** in `/docs`), and with `OXAPAY_MOCK=true`
payments are simulated locally through a mock checkout page that still exercises the real
webhook, HMAC verification and idempotency guard.

```bash
curl http://localhost:3000/api/wallet/balance -H "x-dev-user-email: elena.petrova@example.com"
```

The seed prints which account to use for what. `npx prisma db seed` wipes and rebuilds, so it is
safe to run whenever the data gets messy. A full demo script lives in
[CLAUDE.md § 12 "Demo runbook"](CLAUDE.md).

### Other commands

```bash
npm run build                   # compile to dist/
npm run start:prod              # node dist/main
npm run lint                    # eslint --fix
npx prisma studio               # browse the database
npx prisma migrate dev --name x # new migration
ngrok http 3000                 # public URL for live OxaPay callbacks
```

## For the frontend

Three conventions hold on every endpoint:

- **Money** is always a string with exactly 2 decimals — `"24.99"`, never `24.99`. All USD.
- **Timestamps** are always ISO-8601 UTC — `"2026-08-30T09:12:44.000Z"` — or `null`.
- **Errors** are always `{ statusCode, message, error }`, and `message` is always a single
  string you can render directly (multiple validation messages are joined with `"; "`).

`deliveryInfo` — the credentials or instructions the buyer paid for — is returned by exactly one
endpoint, `GET /api/orders/:id`, and only when the caller is the **buyer** and the order is
`PAID`, `DISPUTED` or `REFUNDED`. It is not selected anywhere else, including for the seller who
wrote it.

Endpoints, request bodies and example responses are all in `/docs`.

| Group     | Routes                                                                                 |
| --------- | -------------------------------------------------------------------------------------- |
| users     | `GET/PATCH /api/me`                                                                      |
| listings  | `GET /api/listings` *(public)*, `GET /api/listings/:id` *(public)*, `GET /api/listings/mine`, `POST`, `PATCH /:id`, `DELETE /:id` |
| orders    | `POST /api/orders`, `GET /api/orders/purchases`, `GET /api/orders/sales`, `GET /api/orders/:id` |
| wallet    | `GET /api/wallet/balance`, `GET /api/wallet/orders`, `POST /api/wallet/withdraw`, `GET /api/wallet/withdrawals` |
| disputes  | `POST /api/orders/:id/dispute`, `GET /api/disputes/mine`, `GET /api/disputes/:id`         |
| admin     | `GET /api/admin/disputes`, `POST /api/admin/disputes/:id/resolve`, `POST /api/admin/disputes/:id/telegram-retry`, `GET /api/admin/orders`, `GET /api/admin/withdrawals`, `GET /api/admin/stats` |
| webhooks  | `POST /api/webhooks/oxapay/payment`, `POST /api/webhooks/oxapay/payout` *(public, HMAC)*  |
| health    | `GET /api/health` *(public)*                                                             |

## Environment variables

Required — the app refuses to start without them:

| Variable                  | What it is                                                       |
| ------------------------- | ---------------------------------------------------------------- |
| `DATABASE_URL`            | Postgres connection string. Matches `docker-compose.yml` as-is.   |
| `CLERK_SECRET_KEY`        | Clerk backend key. Any non-empty string works if you only use the dev bypass. |
| `OXAPAY_MERCHANT_API_KEY` | Merchant key. Also the HMAC key for payment webhooks. Any non-empty string works with `OXAPAY_MOCK=true`. |

Everything else is optional and has a working default:

| Variable                   | Default                 | Notes                                                        |
| -------------------------- | ----------------------- | ------------------------------------------------------------ |
| `PORT`                     | `3000`                  |                                                              |
| `PUBLIC_API_URL`           | `http://localhost:3000` | Where OxaPay sends callbacks. Must be public (ngrok) for live payments. |
| `FRONTEND_URL`             | `http://localhost:3001` | Where OxaPay returns the buyer after paying.                 |
| `CLERK_PUBLISHABLE_KEY`    | —                       | Not used by the backend; kept for parity with the FE.        |
| `ADMIN_EMAILS`             | *(empty)*               | Comma-separated. These e-mails are forced to `role = ADMIN` on login. The seed makes the first one the admin. |
| `DEV_AUTH_BYPASS`          | `false`                 | **Dev only.** Accept `x-dev-user-email` instead of a Clerk token. Ignored in production. |
| `OXAPAY_PAYOUT_API_KEY`    | —                       | Needed for real withdrawals. Also the HMAC key for payout webhooks. |
| `OXAPAY_MOCK`              | `false`                 | **Dev only.** Fake invoices and payouts, and mount the mock checkout at `/api/dev/*`. |
| `OXAPAY_SANDBOX`           | `false`                 | Passes `sandbox: true` to OxaPay for test payments.          |
| `VESTING_DAYS`             | `30`                    | Escrow hold. `0` = withdrawable immediately. Applies at payment time only — changing it never moves an existing order's date. |
| `DISPUTE_WINDOW_DAYS`      | `30`                    | How long after `paidAt` a buyer may open a dispute.          |
| `PLATFORM_FEE_PERCENT`     | `5`                     | Taken off the top; the seller escrows `price − fee`.         |
| `MIN_WITHDRAWAL_USD`       | `1`                     | Below this, `POST /wallet/withdraw` returns 400.             |
| `TELEGRAM_API_ID`          | —                       | All Telegram vars are optional. Without them disputes still work end to end; the invite link is simply `null`. |
| `TELEGRAM_API_HASH`        | —                       | From https://my.telegram.org.                                |
| `TELEGRAM_SESSION`         | —                       | GramJS StringSession for the support account. Generate once with `npm run telegram:login`. |
| `TELEGRAM_BOT_TOKEN`       | —                       | Bot that posts dispute updates into the group.               |
| `TELEGRAM_BOT_USERNAME`    | —                       | Added to every dispute group.                                |
| `TELEGRAM_ADMIN_USERNAMES` | —                       | Comma-separated, added and promoted in every dispute group.  |

`DEV_AUTH_BYPASS` and `OXAPAY_MOCK` are hard-disabled whenever `NODE_ENV=production`.

## Layout

```
prisma/schema.prisma    the whole data model
prisma/seed.ts          destructive demo seed, prints a balance table
src/common/             guards (Clerk, admin), the global error filter, Decimal helpers
src/modules/wallet/     the escrow rules — getWithdrawableOrders() is the single source of truth
src/modules/payments/   every OxaPay HTTP call, plus the signed webhooks
src/modules/telegram/   dispute group creation (GramJS) and bot messages
src/modules/dev/        dev-only mock checkout, never mounted in production
```

Hackathon project: no test suite, no queues, no event bus. Controller → service → Prisma.
