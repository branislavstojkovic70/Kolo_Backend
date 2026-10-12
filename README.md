# Kolo backend

The API behind [Kolo](https://github.com/branislavstojkovic70/Kolo_Frontend), a marketplace where
people share the spare months on their subscriptions. The platform holds the buyer's money in
**escrow** instead of asking them to trust a stranger: buyers pay in crypto, sellers are paid out
to their own wallet once each order clears, and an admin settles anything that goes wrong.

NestJS 11, PostgreSQL 16, Prisma, Clerk, OxaPay and Telegram. REST API under `/api`, interactive
docs at **`/docs`**.

## How the money works

1. A buyer pays a listing's price in crypto to **Kolo's** OxaPay merchant account, not to the
   seller.
2. When the payment webhook arrives, the order becomes `PAID` and gets a **clearing date**
   (`paidAt + VESTING_DAYS`, 30 by default). The date is fixed at that moment and never
   recalculated.
3. Once an order passes *its own* date, the seller can withdraw it. There is no wallet table:
   every balance is calculated from the orders themselves.
4. Within `DISPUTE_WINDOW_DAYS` the buyer can open a **dispute**. The order freezes even if it has
   cleared, and a Telegram group is created for the buyer, the seller and an admin.
5. The admin picks a winner. If the seller wins, the order goes back to `PAID` with its original
   date. If the buyer wins, it becomes `REFUNDED` and the buyer can withdraw the money immediately.

Clearing is **per order**: a seller with three sales usually has three different unlock dates, and
`POST /api/wallet/withdraw` pays out only the ones that have cleared.

Two more rules sit on top of this:

- **Listings sell units.** A listing has a quantity, and each unpaid order holds one unit for
  `AUTO_BUY_RESERVATION_MINUTES` (15 by default). Claims lock the listing row, so two buyers can
  never get the same unit.
- **Deal Alerts (auto-buy).** A buyer registers "buy this product at or below this price". When a
  matching listing exists or appears, the backend creates the order and holds a unit; the buyer
  still pays the invoice themselves.

## Run it locally

Needs Node 20 or newer, and Docker.

```bash
npm install
cp .env.example .env            # then adjust it, see below
docker compose up -d            # postgres:16 on :5432
npx prisma migrate deploy       # create the schema
npx prisma db seed              # demo data, and a printed table of who to log in as
npm run start:dev               # API on :3000
```

Then open **http://localhost:3000/docs**.

You don't need Clerk, OxaPay or Telegram accounts to run all of it. Set these in `.env`:

```bash
DEV_AUTH_BYPASS=true                  # authenticate with an x-dev-user-email header
OXAPAY_MOCK=true                      # simulated invoices and payouts
FRONTEND_URL=http://localhost:5173    # where the checkout sends the buyer back (the web app's port)
PLATFORM_FEE_PERCENT=4                # the fee the live app uses (the code default is 5)
```

With the dev bypass, any e-mail works: an unknown one simply gets a new, empty account. In
`/docs`, enter it under **Authorize**. From the command line:

```bash
curl http://localhost:3000/api/wallet/balance -H "x-dev-user-email: marcus.reid@example.com"
```

```json
{"available":"51.84","vesting":"13.44","disputed":"0.00","withdrawing":"0.00","withdrawn":"0.00","nextVestingAt":"2026-11-02T21:49:01.445Z"}
```

With `OXAPAY_MOCK=true`, an order's payment link opens a mock checkout page at
`/api/dev/mock-pay/:orderId` with *Simulate payment* and *Simulate expiry* buttons. They go through
the real webhook handler, signature check and duplicate guard.

### Demo data

- `npx prisma db seed` wipes the database and rebuilds it: a main demo account with money in every
  part of the wallet, Marcus, Priya and Tom at `@example.com`, and an admin from `ADMIN_EMAILS`.
  It then prints which account to use for what. Safe to rerun whenever the data gets messy.
- `npm run demo:seed` builds the dataset used for the live walkthrough, around the team's real
  accounts. It also rewrites every listing and order, but keeps each real user's Clerk link so
  nobody has to sign in again.

A step-by-step demo script is in [CLAUDE.md, section 12 "Demo runbook"](CLAUDE.md).

### Other commands

```bash
npm run build                   # compile to dist/
npm run start:prod              # node dist/main
npm run lint                    # eslint --fix
npm run format                  # prettier
npm run telegram:login          # one-time: create TELEGRAM_SESSION for the support account
npx prisma studio               # browse the database
npx prisma migrate dev --name x # new migration
ngrok http 3000                 # public URL for live OxaPay callbacks
```

## API overview

Three conventions hold on every endpoint:

- **Money** is always a string with exactly 2 decimals: `"24.99"`, never `24.99`. All USD.
- **Timestamps** are ISO-8601 UTC (`"2026-08-30T09:12:44.000Z"`) or `null`.
- **Errors** are always `{ statusCode, message, error }`, and `message` is a single string you can
  show as is (several validation messages are joined with `"; "`).

`deliveryInfo`, the access details the buyer paid for, is returned by exactly one endpoint:
`GET /api/orders/:id`, and only when the caller is the **buyer** and the order is `PAID`,
`DISPUTED` or `REFUNDED`. It is never returned anywhere else, not even to the seller who wrote it.

Request bodies and example responses for every route are in `/docs`.

| Group | Routes |
| --- | --- |
| platform | `GET /api/config` (fee, clearing days, payout networks…), `GET /api/products` (the catalogue), `GET /api/health`, all public |
| users | `GET /api/me`, `PATCH /api/me` |
| listings | `GET /api/listings`, `GET /api/listings/stats`, `GET /api/listings/:id` (public); `GET /api/listings/mine`, `POST /api/listings`, `PATCH /api/listings/:id`, `DELETE /api/listings/:id` |
| orders | `POST /api/orders`, `GET /api/orders` (`?role=all\|buying\|selling`), `GET /api/orders/purchases`, `GET /api/orders/sales`, `GET /api/orders/:id` |
| wallet | `GET /api/wallet/balance`, `GET /api/wallet/orders`, `POST /api/wallet/withdraw`, `GET /api/wallet/withdrawals` |
| deal alerts | `POST /api/buy-requests`, `GET /api/buy-requests/mine`, `GET /api/buy-requests/:id`, `DELETE /api/buy-requests/:id` |
| savings | `GET /api/stats/savings` (the buyer's total saved against retail) |
| disputes | `POST /api/orders/:id/dispute`, `GET /api/disputes/mine`, `GET /api/disputes/:id` |
| admin | `GET /api/admin/stats`, `GET /api/admin/disputes`, `POST /api/admin/disputes/:id/resolve`, `POST /api/admin/disputes/:id/telegram-retry`, `GET /api/admin/orders`, `GET /api/admin/withdrawals`, `GET /api/admin/buy-requests` |
| webhooks | `POST /api/webhooks/oxapay/payment`, `POST /api/webhooks/oxapay/payout` (public, signature-checked) |
| cron | `GET /api/cron/auto-buy` (needs `Authorization: Bearer $CRON_SECRET`) |
| dev | `GET`/`POST /api/dev/mock-pay/:orderId`, `POST /api/dev/mock-payout/:withdrawalId` (mock mode only) |

## Environment variables

Required. The app refuses to start without the first three, and Prisma needs the fourth:

| Variable | What it is |
| --- | --- |
| `DATABASE_URL` | Postgres connection string. Works with `docker-compose.yml` as is. |
| `CLERK_SECRET_KEY` | Clerk backend key. Any non-empty string works if you only use the dev bypass. |
| `OXAPAY_MERCHANT_API_KEY` | Merchant key, also used to check payment webhook signatures. Any non-empty string works with `OXAPAY_MOCK=true`. |
| `DIRECT_URL` | Direct database connection for migrations. Locally, the same value as `DATABASE_URL`. |

Everything else is optional:

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | |
| `PUBLIC_API_URL` | `http://localhost:3000` | Where OxaPay sends callbacks. Must be public (for example via ngrok) for live payments. |
| `FRONTEND_URL` | `http://localhost:3001` | Where OxaPay sends the buyer after paying (`/orders/:id`). Set it to the web app's URL. |
| `CLERK_PUBLISHABLE_KEY` | none | Not used by the backend; kept to match the frontend. |
| `ADMIN_EMAILS` | *(empty)* | Comma-separated. These e-mails become `ADMIN` on login; the seed makes the first one the admin. |
| `DEV_AUTH_BYPASS` | `false` | **Dev only.** Accept `x-dev-user-email` instead of a Clerk token. |
| `OXAPAY_PAYOUT_API_KEY` | none | Needed for real withdrawals; also checks payout webhook signatures. |
| `OXAPAY_MOCK` | `false` | **Dev only.** Fake invoices and payouts, and mount the mock checkout under `/api/dev`. |
| `OXAPAY_SANDBOX` | `false` | Ask OxaPay for sandbox (test) payments. |
| `VESTING_DAYS` | `30` | The clearing period. `0` makes a sale withdrawable immediately. It applies at payment time only, so changing it never moves an existing order's date. |
| `DISPUTE_WINDOW_DAYS` | `30` | How long after payment a buyer can open a dispute. |
| `PLATFORM_FEE_PERCENT` | `5` | Taken off the top; the seller receives the price minus the fee. The live app uses `4`. |
| `MIN_WITHDRAWAL_USD` | `1` | Below this, `POST /api/wallet/withdraw` returns 400. |
| `AUTO_BUY_RESERVATION_MINUTES` | `15` | How long an unpaid order (manual or auto-buy) holds its unit. |
| `AUTO_BUY_ENABLED` | `true` | Only the string `false` turns off the every-minute clean-up and re-matching job. |
| `CRON_SECRET` | *(empty)* | Bearer token for `GET /api/cron/auto-buy`. Unset means that route answers 401. |
| `TELEGRAM_API_ID` | none | All Telegram variables are optional. Without them, disputes still work end to end; the invite link is just `null`. |
| `TELEGRAM_API_HASH` | none | From https://my.telegram.org. |
| `TELEGRAM_SESSION` | none | Session string for the support account. Generate it once with `npm run telegram:login`. |
| `TELEGRAM_BOT_TOKEN` | none | Bot that posts dispute updates into the group. |
| `TELEGRAM_BOT_USERNAME` | none | Added to every dispute group. |
| `TELEGRAM_ADMIN_USERNAMES` | none | Comma-separated; added and promoted in every dispute group. |

`DEV_AUTH_BYPASS` and `OXAPAY_MOCK` are switched off whenever `NODE_ENV=production`.

## Deploying (Vercel and Supabase)

The API runs on Vercel with a Supabase Postgres database. Serverless changes three things:

- **Database URLs.** `DATABASE_URL` can point at Supabase's connection pooler; `DIRECT_URL` must be
  the direct connection, because migrations can't run through the pooler. Run
  `npx prisma migrate deploy` against it.
- **The catalogue.** The boot-time sync from `prisma/products.json` is skipped on Vercel, because
  that file isn't bundled. Load the catalogue by running the seed against the production database
  once. **The seed wipes all data**, so only do this on a fresh database.
- **Background jobs.** The every-minute auto-buy job can't run between serverless requests.
  [`vercel.json`](vercel.json) calls `GET /api/cron/auto-buy` once a day as a fallback; for
  every-minute matching, point an external scheduler at it with
  `Authorization: Bearer $CRON_SECRET`.

## Project layout

```
prisma/schema.prisma      the whole data model
prisma/products.json      the product catalogue sellers can list
prisma/seed.ts            destructive demo seed (npx prisma db seed)
prisma/demo.ts            the live-walkthrough dataset (npm run demo:seed)
src/common/               guards (Clerk, admin), the global error filter, Decimal helpers
src/modules/wallet/       the escrow rules: getWithdrawableOrders() is the single source of truth
src/modules/inventory/    listing units and reservations: the only code that touches stock
src/modules/buy-requests/ Deal Alerts: matching, reservations and the cron endpoint
src/modules/payments/     every OxaPay call, plus the signed webhooks
src/modules/telegram/     dispute group creation and bot messages
src/modules/dev/          the mock checkout, never mounted in production
scripts/telegram-login.ts one-time Telegram session setup
```

This is a hackathon project: no test suite, no queues, no event bus. Every module is controller,
then service, then Prisma. Seller ratings and card payments are not built.

## License

No license has been chosen yet, so all rights are reserved by default.
