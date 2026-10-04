# CLAUDE.md

Guidance for Claude Code when working in this repository.

---

## 1. Project

**Digital Services Marketplace (escrow) — hackathon MVP backend.**

Users sell digital services/accounts (e.g. "YouTube Premium 1 year"). Buyers pay in crypto via
OxaPay to **our** OxaPay merchant account. Funds are held in escrow with a **vesting period**
(default 30 days) before the seller can withdraw them to their own crypto wallet. Buyers can open
a **dispute**, which creates a Telegram discussion space between buyer, seller and admin and
freezes the withdrawal. An admin decides who wins; the winner gets the money.

### THIS IS A HACKATHON PROJECT

Non-negotiable working rules:

- **Speed > perfection.** Ship working endpoints. No premature abstraction.
- **No unit tests, no e2e tests.** Do not write `*.spec.ts` files. Delete generated ones.
- **No CQRS, no event bus, no repository pattern, no interfaces-for-everything.**
  Controller → Service → PrismaService. That's it.
- **No queues, no Redis, no workers.** Everything synchronous inside the request or in a webhook.
- **No soft-delete / audit tables** beyond what is specified here.
- Business rules live in **one** service each. Never duplicate the balance rules.
- If something is ambiguous, pick the simplest option that works, add a `// TODO:` and keep going.
  Don't stop to ask unless it's about money-moving logic.

---

## 2. Stack

| Concern     | Choice                                                        |
| ----------- | ------------------------------------------------------------- |
| Runtime     | Node.js 20+, TypeScript                                       |
| Framework   | NestJS 11                                                     |
| DB          | PostgreSQL 16 (docker-compose locally)                        |
| ORM         | Prisma (`@prisma/client`, `prisma`)                           |
| Auth        | Clerk (`@clerk/backend`) — Google OAuth only, done on FE      |
| Payments    | OxaPay Merchant API (invoices) + Payout API (withdrawals)     |
| Disputes    | Telegram: GramJS (MTProto) creates the group, Bot API posts   |
| Validation  | `class-validator` + `class-transformer`, global ValidationPipe |
| Config      | `@nestjs/config` (`isGlobal: true`)                           |
| Docs        | `@nestjs/swagger` at `/docs` (cheap, helps the FE team)       |
| HTTP client | native `fetch` (Node 20) — do **not** add axios               |

Package manager: **npm**.

---

## 3. Money model & core rules (READ BEFORE TOUCHING ANY MONEY CODE)

- All internal accounting is in **USD**, stored as Prisma `Decimal(18, 2)`.
- We assume **1 USDT = 1 USD** for payouts. Documented shortcut, fine for the hackathon.
- **Never** compute balances with JS floats. Use `Prisma.Decimal` / `decimal.js` arithmetic.
- The platform holds all funds on **our** OxaPay account. Users have no wallets in our DB —
  a user's balance is **always derived from Orders**, never stored as a mutable column.

### Order lifecycle

```
PENDING_PAYMENT ──(oxapay webhook: paid)──> PAID ──(vesting passes)──> withdrawable by seller
       │                                      │
       │                                      ├──(buyer opens dispute)──> DISPUTED
  (expired/failed)                            │        │
       ↓                                      │        ├─ admin: SELLER wins → back to PAID
    EXPIRED                                   │        └─ admin: BUYER wins  → REFUNDED
                                              │                (beneficiary = buyer,
                                              │                 vestedAt = now)
                                              └──(withdrawn)──> withdrawal linked
```

### The single source of truth: withdrawable funds

An order's `sellerAmountUsd` is **withdrawable by user U** if and only if:

1. `order.status IN (PAID, REFUNDED)`
2. `order.beneficiaryId === U.id`
3. `order.vestedAt <= now()`
4. the order has **no dispute with status OPEN**
5. `order.withdrawalId IS NULL`

This rule is implemented **once**, in `WalletService.getWithdrawableOrders(userId)`.
`getBalance()` and `createWithdrawal()` both call it. Do not re-implement it anywhere.

Balance buckets returned to the FE:

- `available` — passes all 5 rules above
- `vesting` — status `PAID`, beneficiary = U, no open dispute, `vestedAt > now()`
- `disputed` — beneficiary = U, has an `OPEN` dispute
- `withdrawing` — linked to a withdrawal that is `PENDING` or `PROCESSING`
- `withdrawn` — linked to a `COMPLETED` withdrawal

### Vesting

- `VESTING_DAYS` env, default `30`.
- Set **per payment**: on the paid webhook → `vestedAt = paidAt + VESTING_DAYS days`.
- Never recalculated globally. Changing the env later must not affect existing orders.
- Add `VESTING_DAYS=0` support so the demo can be shown live.

### Dispute rules

- Only the **buyer** can open a dispute, only on an order with status `PAID`,
  only if no dispute exists yet, and only within `DISPUTE_WINDOW_DAYS` (default 30) of `paidAt`.
- Opening a dispute sets `order.status = DISPUTED`. Withdrawal is blocked **even if vesting passed**.
- Admin resolves:
  - **SELLER wins** → `dispute.status = RESOLVED_SELLER`, `order.status = PAID`,
    beneficiary stays the seller, `vestedAt` **unchanged** (if vesting hasn't passed, he waits).
  - **BUYER wins** → `dispute.status = RESOLVED_BUYER`, `order.status = REFUNDED`,
    `order.beneficiaryId = buyerId`, `order.vestedAt = now()` (buyer can withdraw immediately).
- The refund is a **withdrawal by the buyer** from our OxaPay balance — we never call an
  OxaPay "refund" API. Buyer withdraws exactly like a seller does.

### Withdrawals

- **MVP: withdraw the full `available` bucket.** No `amount` parameter. The user supplies only
  `address`, `network` and optionally `currency` (default `USDT`).
  Rationale: partial withdrawals would require splitting order amounts. Not worth it today.
- **"Available" does NOT mean "everything the user earned".** It means *only the orders that
  individually passed their own vesting* (all 5 rules above). Orders still vesting, or under an
  open dispute, are simply not part of the query result — they cannot be dragged along.
- **Vesting is per-order, frozen at payment time.** It is never derived from the user's latest
  sale, never recalculated, never averaged across orders. Two orders of the same seller routinely
  have different `vestedAt` values and that is the whole point.

Worked example — seller has three paid orders, `VESTING_DAYS=30`, today is day 0:

| Order | Paid       | `vestedAt` | `sellerAmountUsd` | Bucket    |
| ----- | ---------- | ---------- | ----------------- | --------- |
| A     | 45 days ago | day −15   | 20.00             | available |
| B     | 20 days ago | day +10   | 35.00             | vesting   |
| C     | 2 days ago  | day +28   | 10.00             | vesting   |

`GET /wallet/balance` → `available: "20.00"`, `vesting: "45.00"`.
`POST /wallet/withdraw` pays out **20.00** and links only order A to the `Withdrawal`.
B and C stay untouched and become withdrawable on their own dates, in two later withdrawals.
If A were under an open dispute instead, `available` would be `"0.00"` and the withdraw call
would return 400.
- Flow (all inside one Prisma `$transaction` where possible):
  1. Load withdrawable orders. If empty or sum < `MIN_WITHDRAWAL_USD` (default `1`) → 400.
  2. Create `Withdrawal` row, status `PENDING`, `amountUsd = sum`.
  3. Set `withdrawalId` on those orders (this "reserves" them — prevents double-spend).
  4. Call OxaPay payout **after** the transaction commits.
  5. On success → status `PROCESSING` + save `oxapayTrackId`.
     On API error → status `FAILED`, `error = message`, and **unlink the orders**
     (`withdrawalId = null`) so the funds become available again.
  6. Payout webhook flips `PROCESSING → COMPLETED` (or `FAILED` + unlink).

---

## 4. Database (Prisma schema)

`prisma/schema.prisma`. Use `cuid()` ids. Every model has `createdAt` / `updatedAt`.

```prisma
enum Role            { USER ADMIN }
enum ListingStatus   { ACTIVE PAUSED SOLD_OUT RESERVED SOLD DELETED }
enum BuyRequestStatus{ ACTIVE MATCHED FULFILLED CANCELLED EXPIRED }
enum OrderStatus     { PENDING_PAYMENT PAID DISPUTED REFUNDED EXPIRED }
enum DisputeStatus   { OPEN RESOLVED_BUYER RESOLVED_SELLER }
enum WithdrawalStatus{ PENDING PROCESSING COMPLETED FAILED }

// The predefined product catalog. Sellers can ONLY list products that exist here —
// no more free-text titles. Source of truth is prisma/products.json, upserted by slug
// on every boot (ProductsService.onModuleInit) — idempotent, price/name changes update
// the row in place, never duplicate.
model Product {
  id             String  @id @default(cuid())
  slug           String  @unique
  name           String
  category       String
  retailPriceUsd Decimal @db.Decimal(18, 2)   // official/regular price
  imageUrl       String?
  active         Boolean @default(true)
  listings       Listing[]
  orders         Order[]
}

model User {
  id               String  @id @default(cuid())
  clerkUserId      String  @unique          // subject from the Clerk JWT
  email            String  @unique
  username         String?                  // display name
  imageUrl         String?
  telegramUsername String?                  // informational only — shown in the dispute group's
                                            // opening message. NOT used to add anyone to a group.
  role             Role    @default(USER)

  listings        Listing[]
  purchases       Order[]  @relation("buyer")
  sales           Order[]  @relation("seller")
  beneficiaryOf   Order[]  @relation("beneficiary")
  withdrawals     Withdrawal[]
  openedDisputes  Dispute[] @relation("openedBy")
  resolvedDisputes Dispute[] @relation("resolvedBy")
}

model Listing {
  id          String        @id @default(cuid())
  sellerId    String
  seller      User          @relation(fields: [sellerId], references: [id])
  productId   String        // REQUIRED — the catalog product; immutable after creation
  product     Product       @relation(fields: [productId], references: [id])
  title       String        // COPIED from product.name at write time (keeps old response shapes)
  description String
  category    String?       // COPIED from product.category at write time
  imageUrl    String?       // external cover-image URL; we store the link only
  priceUsd    Decimal       @db.Decimal(18, 2)
  // shown to the buyer only after payment (credentials, instructions, contact)
  deliveryInfo String?
  status      ListingStatus @default(ACTIVE)
  // auto-buy reservation (status RESERVED): held for this buyer until this moment
  reservedUntil DateTime?
  reservedForId String?
  orders      Order[]

  @@index([status, createdAt])
  @@index([sellerId])
}

model Order {
  id        String      @id @default(cuid())
  listingId String
  listing   Listing     @relation(fields: [listingId], references: [id])
  buyerId   String
  buyer     User        @relation("buyer", fields: [buyerId], references: [id])
  sellerId  String
  seller    User        @relation("seller", fields: [sellerId], references: [id])

  // snapshot at purchase time — listing may change later
  titleSnapshot   String
  // catalog product + retail price frozen AT PURCHASE TIME. Buyer savings are
  // always computed from this snapshot, never from the live catalog.
  productId              String
  product                Product @relation(fields: [productId], references: [id])
  retailPriceUsdSnapshot Decimal @db.Decimal(18, 2)
  amountUsd       Decimal @db.Decimal(18, 2)  // what the buyer pays
  feeUsd          Decimal @db.Decimal(18, 2)  // platform fee
  sellerAmountUsd Decimal @db.Decimal(18, 2)  // amount - fee = escrowed amount

  status OrderStatus @default(PENDING_PAYMENT)

  // who is allowed to withdraw sellerAmountUsd (seller by default, buyer if he wins a dispute)
  beneficiaryId String
  beneficiary   User   @relation("beneficiary", fields: [beneficiaryId], references: [id])

  oxapayTrackId String?  @unique
  paymentUrl    String?
  paidAt        DateTime?
  vestedAt      DateTime?      // paidAt + VESTING_DAYS

  withdrawalId String?
  withdrawal   Withdrawal? @relation(fields: [withdrawalId], references: [id])

  dispute Dispute?

  @@index([buyerId, createdAt])
  @@index([sellerId, createdAt])
  @@index([beneficiaryId, status])
}

model Dispute {
  id       String        @id @default(cuid())
  orderId  String        @unique
  order    Order         @relation(fields: [orderId], references: [id])
  openedById String
  openedBy   User        @relation("openedBy", fields: [openedById], references: [id])
  reason   String
  status   DisputeStatus @default(OPEN)

  telegramChatId     String?   // group id returned by MTProto (store as string, it can change)
  telegramInviteLink String?   // durable handle, shown to buyer & seller in the UI

  resolvedById String?
  resolvedBy   User?   @relation("resolvedBy", fields: [resolvedById], references: [id])
  resolutionNote String?
  resolvedAt   DateTime?
}

model Withdrawal {
  id       String           @id @default(cuid())
  userId   String
  user     User             @relation(fields: [userId], references: [id])
  amountUsd Decimal         @db.Decimal(18, 2)
  currency String           @default("USDT")
  network  String           // TRC20 / BEP20 / TON ...
  address  String
  status   WithdrawalStatus @default(PENDING)
  oxapayTrackId String?     @unique
  error    String?
  completedAt DateTime?
  orders   Order[]
}

// auto-buy: a standing wish "buy <product> at or below maxPriceUsd"
model BuyRequest {
  id          String           @id @default(cuid())
  buyerId     String
  buyer       User             @relation(fields: [buyerId], references: [id])
  productId   String
  product     Product          @relation(fields: [productId], references: [id])
  maxPriceUsd Decimal          @db.Decimal(18, 2)
  status      BuyRequestStatus @default(ACTIVE)
  expiresAt   DateTime?        // optional, buyer-set
  matchedListingId String?
  matchedOrderId   String?
  matchedAt        DateTime?
  @@index([productId, status])
}

// idempotency guard for OxaPay callbacks
model WebhookEvent {
  id        String   @id @default(cuid())
  provider  String   @default("oxapay")
  type      String   // payment | payout
  trackId   String
  status    String
  payload   Json
  createdAt DateTime @default(now())

  @@unique([provider, type, trackId, status])
}
```

Migrations: `npx prisma migrate dev --name <name>`. Client is generated to the default location.

---

## 5. File structure

```
prisma/
  schema.prisma
  seed.ts                        # admin user + a few demo listings
src/
  main.ts                        # ValidationPipe, CORS, Swagger, RAW BODY for webhooks
  app.module.ts
  config/
    configuration.ts             # typed config() factory
    env.validation.ts            # class-validator on process.env, fail fast
  prisma/
    prisma.module.ts             # @Global()
    prisma.service.ts
  common/
    guards/clerk-auth.guard.ts   # verifies Clerk JWT, upserts + attaches user
    guards/admin.guard.ts        # requires role === ADMIN
    decorators/current-user.decorator.ts
    decorators/public.decorator.ts   # @Public() to skip auth (webhooks, listings feed)
    dto/pagination.dto.ts
    money.ts                     # Decimal helpers: sum(), toFixed2(), calcFee()
  modules/
    users/       users.module.ts   users.controller.ts   users.service.ts   dto/
    products/    products.module.ts products.controller.ts products.service.ts  # catalog, synced from prisma/products.json on boot
    listings/    listings.module.ts listings.controller.ts listings.service.ts dto/
    orders/      orders.module.ts  orders.controller.ts  orders.service.ts  dto/
    buy-requests/ buy-requests.module.ts buy-requests.controller.ts buy-requests.service.ts auto-buy.service.ts dto/  # auto-buy
    stats/       stats.module.ts   stats.controller.ts   stats.service.ts   # buyer savings
    wallet/      wallet.module.ts  wallet.controller.ts  wallet.service.ts  dto/
    disputes/    disputes.module.ts disputes.controller.ts disputes.service.ts dto/
    admin/       admin.module.ts   admin.controller.ts   admin.service.ts   dto/
    payments/    payments.module.ts oxapay.service.ts    webhooks.controller.ts
    telegram/    telegram.module.ts telegram.service.ts
```

Rules:
- `ClerkAuthGuard` is registered as a **global** `APP_GUARD`; opt out with `@Public()`.
- `PrismaModule` is `@Global()` — never import it in feature modules.
- DTOs always use `class-validator`. Never accept raw `any` bodies (except webhooks).
- Controllers do no business logic. Services do no HTTP concerns.

---

## 6. API surface

All routes prefixed `/api`. `401` if no valid Clerk token unless marked public.

### Users
- `GET  /api/me` → current user (auto-created on first authenticated request)
- `PATCH /api/me` → `{ username?, telegramUsername? }`

### Products
- `GET /api/products` **(public)** → the active catalog, sorted by category then name.
  Feeds the "create listing" dropdown; `retailPriceUsd` is the official price the FE
  strikes through next to the seller's price. The catalog lives in `prisma/products.json`
  and is upserted by slug on every boot — edit the file, restart, done. No write API.

### Listings
- `GET  /api/listings` **(public)** → `?search=&category=&minPrice=&maxPrice=&sort=&page=&limit=`
  — only `ACTIVE`, **never** returns `deliveryInfo`. `sort` is
  `newest` (default) | `oldest` | `price_asc` | `price_desc`.
- `GET  /api/listings/stats` **(public)** → `{ total, categories[], catalogueValueUsd, medianPriceUsd }`
  — counted over every `ACTIVE` listing in SQL. The FE must not average a page of results instead.
- `GET  /api/listings/:id` **(public)** — no `deliveryInfo`
- `GET  /api/listings/mine` → same filters as the public feed, paginated (includes `PAUSED`)
- `POST /api/listings` → `{ productId, description, imageUrl?, priceUsd, quantity?, deliveryInfo? }`
  - `productId` must be an **active catalog product** — unknown or inactive → 400.
    `title` and `category` are copied from the product at write time; they are no longer
    user input, but the columns stay populated so every read keeps its old shape.
  - `imageUrl` is a plain external http(s) link (validated, max 2048 chars); defaults to the
    product image. We store the link and nothing else — no uploads, no hosting, no resizing.
- `PATCH /api/listings/:id` (owner only) — may change `description`, `priceUsd`,
  `deliveryInfo` (plus `imageUrl` / `quantity` / `status`) — **never** `productId`.
- `DELETE /api/listings/:id` (owner only → status `DELETED`)
- Every listing read also embeds `product`
  `{ id, slug, name, category, retailPriceUsd, imageUrl }` for the struck-through retail price.

### Orders
- `POST /api/orders` → `{ listingId }`
  - reject if buyer === seller, or listing not `ACTIVE`
  - compute fee, create order `PENDING_PAYMENT`, call OxaPay invoice, store
    `oxapayTrackId` + `paymentUrl`, return `{ order, paymentUrl }`
  - copies `productId` from the listing and snapshots `retailPriceUsdSnapshot` from the
    product **at purchase time** — savings are never recomputed from the live catalog.
  - every order read now also returns `productId` + `retailPriceUsdSnapshot` (string).
- `GET  /api/orders` → `?role=all|buying|selling&search=&status=&page=&limit=` → `Page<Order>`
  - The list the FE uses. Two separately paginated lists cannot be merged into one page, so the
    combined "all my orders" view needs its own query.
- `GET  /api/orders/purchases` → same filters, buyer side only → `Page<Order>`
- `GET  /api/orders/sales` → same filters, seller side only → `Page<Order>`
- `GET  /api/orders/:id` — buyer or seller only. `deliveryInfo` included **only** for the
  buyer and **only** when status is `PAID` / `DISPUTED` / `REFUNDED`.

### Wallet
- `GET  /api/wallet/balance` → `{ available, vesting, disputed, withdrawing, withdrawn, nextVestingAt }`
- `GET  /api/wallet/orders` → per-order breakdown for the FE table
- `POST /api/wallet/withdraw` → `{ address, network, currency? }` — withdraws the `available`
  bucket only (vested, undisputed, unlinked orders). Orders still vesting are untouched.
- `GET  /api/wallet/withdrawals`

### Disputes
- `POST /api/orders/:id/dispute` → `{ reason }` (buyer only) → creates dispute + Telegram group,
  responds with `telegramInviteLink` (may be `null` if Telegram failed)
- `GET  /api/disputes/mine` → `?search=&status=&page=&limit=` → `Page<Dispute>`
  (`search` matches the disputed order's title)
- `GET  /api/disputes/:id` (buyer, seller or admin) — includes `telegramInviteLink` for all three,
  so the FE can render a "Join dispute chat" button on the order view for **both** parties

### Buy requests (auto-buy)

A buyer registers a standing wish: "buy `<product>` the moment a listing appears at or below
`maxPriceUsd`". Matching is **synchronous** (at listing creation and at request creation); a
minute-cron (`@nestjs/schedule`, gated by `AUTO_BUY_ENABLED`) only cleans up expired
reservations/requests and re-matches as a safety net. The buyer pays the OxaPay invoice
themselves — there is **no** internal deposit balance.

The flow on a match (all claims are conditional `updateMany`s — a lost race aborts cleanly):

1. Listing `ACTIVE → RESERVED` (+1 unit claimed), `reservedForId` = buyer,
   `reservedUntil = now + AUTO_BUY_RESERVATION_MINUTES` (default 15).
2. Order created through the **same** shared path as `POST /api/orders`
   (`OrdersService.createPendingOrderRow` + `attachInvoice`) — same fee, same snapshots.
3. BuyRequest `ACTIVE → MATCHED` with `matchedListingId` / `matchedOrderId` / `matchedAt`.
4. Invoice failure rolls the match back (listing + request `ACTIVE` again, order stays
   `PENDING_PAYMENT` with null trackId). A listing is never left stuck in `RESERVED`.
5. Paid webhook → `AutoBuyService.onOrderPaid` (the one hook): request `FULFILLED`,
   listing `SOLD`, reservation cleared. Unpaid past `reservedUntil` → cron: order `EXPIRED`,
   listing back to `ACTIVE`, request back to `ACTIVE`, then matching re-runs immediately.

A `RESERVED` listing is invisible in the public feed, rejected by `POST /api/orders` (400),
and its status/deletion are locked for the seller until the reservation resolves. It stays
visible in `GET /api/listings/mine` with `reservedUntil` / `reservedForId`.

- `POST   /api/buy-requests` → `{ productId, maxPriceUsd, expiresAt? }` — 400 unknown/inactive
  product, 409 if the buyer already has an `ACTIVE` request for that product. Matches
  immediately against existing listings (cheapest first) — the response may already be
  `MATCHED` with the payment link.
- `GET    /api/buy-requests/mine` → paginated, `?status=` filter; embeds `product` and, for
  `MATCHED`, `matchedOrder { id, amountUsd, paymentUrl, status }`.
- `GET    /api/buy-requests/:id` — owner or admin.
- `DELETE /api/buy-requests/:id` — owner, only while `ACTIVE` → `CANCELLED`; 409 if `MATCHED`
  (cancel by letting the reservation expire).
- `GET    /api/admin/buy-requests` — AdminGuard, paginated, `?status=` filter.

### Stats
- `GET /api/stats/savings` (authenticated — the caller's own savings as a buyer) →
  `{ totalSpentUsd, totalRetailUsd, totalSavedUsd, savedPercent, orderCount, items[] }`
  with `items: [{ orderId, productName, paidUsd, retailUsd, savedUsd, purchasedAt }]`.
  - Counts only orders the buyer got value from: status `PAID` or `DISPUTED`.
    `REFUNDED` is **excluded** (money came back — not a saving), as are
    `PENDING_PAYMENT` and `EXPIRED`.
  - `savedUsd = retailPriceUsdSnapshot - amountUsd` per order, `Prisma.Decimal` only.
    `savedPercent` is a 2-decimal string; `0.00` when `totalRetailUsd` is 0.

### Admin (`AdminGuard`)
- `GET  /api/admin/disputes?status=OPEN`
- `POST /api/admin/disputes/:id/resolve` → `{ winner: "BUYER" | "SELLER", note? }`
- `POST /api/admin/disputes/:id/telegram-retry` — re-run group creation if Telegram failed
- `GET  /api/admin/orders`
- `GET  /api/admin/withdrawals`
- `GET  /api/admin/stats` → counts + volume (nice for the demo). `money` also carries
  `buyerRetailUsd` / `buyerSavedUsd` — platform-wide buyer savings vs. the retail snapshots.

### Webhooks (public, raw body)
- `POST /api/webhooks/oxapay/payment`
- `POST /api/webhooks/oxapay/payout`

### Misc
- `GET /api/health` **(public)**
- `GET /api/config` **(public)** → `{ feePercent, vestingDays, disputeWindowDays, minWithdrawalUsd,
  autoBuyReservationMinutes, payoutCurrencies[], payoutNetworks[] }`
  - Every platform rule the UI displays comes from here. The frontend is not allowed to keep its
    own copy of the fee or the vesting length — a changed env must change the UI, not lie in it.

---

## 7. Clerk auth

Only the backend verification matters here — Google login happens on the frontend.

```ts
import { verifyToken } from '@clerk/backend';

const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
// payload.sub -> clerkUserId; email may be in payload.email or a custom claim
```

`ClerkAuthGuard`:
1. Read `Authorization: Bearer <token>`. Missing → 401.
2. `verifyToken`. Invalid → 401.
3. `prisma.user.upsert({ where: { clerkUserId: payload.sub }, ... })` — **JIT provisioning**,
   no webhook, no sync job. If the email isn't in the token, fall back to
   `clerkClient.users.getUser(sub)` once on create only.
4. Attach to `req.user`.

Admin: seeded manually. `ADMIN_EMAILS` env (comma-separated) — on upsert, if the email is in that
list, force `role = ADMIN`. Simplest possible admin bootstrap.

**Dev bypass:** when `NODE_ENV !== 'production'` and `DEV_AUTH_BYPASS=true`, the guard accepts a
`x-dev-user-email: <email>` header instead of a Bearer token and upserts that user with a synthetic
`clerkUserId` of `dev_<email>`. Every bypassed request logs a loud warning. Never enable it in prod.

---

## 8. OxaPay integration

Everything OxaPay-specific lives in **`payments/oxapay.service.ts`** so API changes are a one-file fix.
Docs: https://docs.oxapay.com — verify field names against the live docs if a call 400s.

### Create invoice
`POST https://api.oxapay.com/v1/payment/invoice`
Header: `merchant_api_key: <OXAPAY_MERCHANT_API_KEY>`

```json
{
  "amount": 12.5,
  "currency": "USD",
  "lifetime": 60,
  "fee_paid_by_payer": 1,
  "order_id": "<our order id>",
  "description": "<listing title>",
  "callback_url": "https://<PUBLIC_API_URL>/api/webhooks/oxapay/payment",
  "return_url": "https://<FRONTEND_URL>/orders/<order id>",
  "sandbox": false
}
```
Response `data`: `{ track_id, payment_url, expired_at }` → store `track_id` and `payment_url`.

### Payout (withdrawal)
`POST https://api.oxapay.com/v1/payout`
Header: `payout_api_key: <OXAPAY_PAYOUT_API_KEY>`

```json
{
  "address": "<user wallet>",
  "currency": "USDT",
  "amount": 12.5,
  "network": "TRC20",
  "callback_url": "https://<PUBLIC_API_URL>/api/webhooks/oxapay/payout",
  "description": "withdrawal <withdrawal id>"
}
```
Response `data`: `{ track_id, status }`.

### Webhooks
- OxaPay sends `HMAC` header = `hmac_sha512(rawBody, key)`.
  Key is the **merchant** key for `type: "payment"`, the **payout** key for `type: "payout"`.
- Verify with `crypto.timingSafeEqual`. Mismatch → `401` and log the body.
- **Raw body is required.** In `main.ts`:
  ```ts
  const app = await NestFactory.create(AppModule, { rawBody: true });
  ```
  and read `req.rawBody` in the controller (`@Req() req: RawBodyRequest<Request>`).
- Body statuses are strings — compare **lowercased**: `waiting`, `confirming`, `paid`,
  `expired`, `failed`. Payout: `confirming`, `complete`/`completed`, `failed`, `rejected`.
- **Idempotency:** first insert into `WebhookEvent`; if the unique constraint throws (P2002),
  return `200 OK` and do nothing else.
- Always return `200` with body `OK` once the signature is valid, even for statuses we ignore —
  otherwise OxaPay retries forever.

Payment webhook handler:
```
find order by oxapayTrackId (fallback: order_id)
if status == paid && order.status == PENDING_PAYMENT:
    status = PAID
    paidAt = now
    vestedAt = now + VESTING_DAYS days
if status in (expired, failed) && order.status == PENDING_PAYMENT:
    status = EXPIRED
```

Local testing: OxaPay will not call localhost — use `ngrok http 3000` and put the ngrok URL in
`PUBLIC_API_URL`. Use `"sandbox": true` while developing.

---

## 9. Telegram disputes

**A real, separate group is created per dispute.** The plain Bot API cannot create groups, so this
goes through **MTProto with a user account** (the platform's "support" account) using
[`telegram` (GramJS)](https://www.npmjs.com/package/telegram).

Setup (done once, by hand, outside the app):
1. Get `api_id` / `api_hash` from https://my.telegram.org.
2. Log the support account in once with a throwaway script and print the **StringSession**.
   Put it in `TELEGRAM_SESSION`. Never log in during a request.
3. Create the bot too (`TELEGRAM_BOT_TOKEN`) — the bot is added to each group so the backend can
   post status updates via the simple Bot API instead of MTProto.

On dispute creation, `TelegramService.createDisputeGroup(dispute)`:
```
client.invoke(new Api.messages.CreateChat({
  users: [...TELEGRAM_ADMIN_USERNAMES, TELEGRAM_BOT_USERNAME],   // admins + bot ONLY
  title: `Dispute #${shortId} — ${listingTitle}`,
}))
→ get chatId
→ EditChatAdmin for the bot and each admin username
→ ExportChatInvite → invite link
→ send the opening message: order id, amount, buyer, seller, reason
```
Store `telegramChatId` + `telegramInviteLink` on the `Dispute`.

**Buyer and seller are never added programmatically.** We do not touch their accounts, do not need
their `telegramUsername`, and never handle `missing_invitees`. They receive the **invite link** and
join themselves. The FE shows the link on the order/dispute view for both parties.

This means the group always contains the admins + the bot from the moment it is created, so an
admin can read and moderate it even before either party joins.

Gotchas that will bite during the demo:
- The support account must have all `TELEGRAM_ADMIN_USERNAMES` reachable (privacy settings / prior
  contact). Since it's your own team's accounts, add them as contacts once and forget it.
  If one of them can't be added, log it and continue — the bot is enough to run the group.
- `ExportChatInvite` must succeed, because the link is the **only** way buyer and seller get in.
  If it throws, mark the dispute's Telegram fields null and rely on the retry endpoint.
- Basic groups get auto-upgraded to supergroups; the chat id changes. Save whatever id the API
  returns and don't rely on it staying stable — the invite link is the durable handle.
- Rate limits: MTProto will throw `FLOOD_WAIT_X`. Catch it, log it, and still create the dispute.

**Telegram must never block the dispute.** Wrap the entire call in try/catch; on failure or when
`TELEGRAM_SESSION` is unset, log a warning, store `null` for the chat fields and return the dispute
as created. Add `POST /api/admin/disputes/:id/telegram-retry` so you can re-run the group creation
manually if it failed.

When the admin resolves, post the outcome into the group via the Bot API (`sendMessage`), then
leave the group open — no need to delete anything.

---

## 10. Environment

`.env` (+ commit a `.env.example`):

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/marketplace
PORT=3000
PUBLIC_API_URL=https://xxxx.ngrok-free.app
FRONTEND_URL=http://localhost:3001

CLERK_SECRET_KEY=sk_test_xxx
CLERK_PUBLISHABLE_KEY=pk_test_xxx
ADMIN_EMAILS=me@example.com

OXAPAY_MERCHANT_API_KEY=xxx
OXAPAY_PAYOUT_API_KEY=xxx
OXAPAY_SANDBOX=true

TELEGRAM_API_ID=1234567                  # my.telegram.org, for GramJS
TELEGRAM_API_HASH=xxx
TELEGRAM_SESSION=<StringSession>         # support account, generated once offline
TELEGRAM_BOT_TOKEN=xxx                   # bot that posts updates into the group
TELEGRAM_BOT_USERNAME=my_escrow_bot
TELEGRAM_ADMIN_USERNAMES=admin1,admin2   # added + promoted to admin in every dispute group

AUTO_BUY_RESERVATION_MINUTES=15   # how long a matched listing is held while the buyer pays
AUTO_BUY_ENABLED=true             # gates the auto-buy cleanup cron
VESTING_DAYS=30
DISPUTE_WINDOW_DAYS=30
PLATFORM_FEE_PERCENT=5
MIN_WITHDRAWAL_USD=1
```

`env.validation.ts` fails fast on missing `DATABASE_URL`, `CLERK_SECRET_KEY`,
`OXAPAY_MERCHANT_API_KEY`. Telegram vars are optional.

---

## 11. Commands

```bash
npm run start:dev              # nest start --watch
npx prisma migrate dev --name x
npx prisma studio
npx prisma db seed
docker compose up -d           # postgres only
ngrok http 3000                # for OxaPay callbacks
```

`docker-compose.yml`: just `postgres:16-alpine`, port 5432, volume. Nothing else.

---

## 12. Demo runbook

### Reset to the demo dataset

```bash
docker compose up -d
npx prisma migrate deploy      # or: npx prisma migrate dev
npx prisma db seed             # wipes everything, reseeds, prints the balance table
npm run start:dev
```

`prisma db seed` is destructive and idempotent on purpose — run it as often as you like,
you always get the same data. It prints a table of every user's balance buckets plus a
cheat sheet of which account to log in as. Read that table before you present.

Every seeded listing/order is tied to a catalog Product at a discount off retail; the seed
also prints a **BUYER SAVINGS** line per buyer that `GET /api/stats/savings` must match —
Tom and Priya are your savings demo accounts from the first second.

Seeded accounts (`x-dev-user-email` values):

| Account                     | Why you'd use it                                        |
| --------------------------- | ------------------------------------------------------- |
| `elena.petrova@example.com` | Seller with money in **every** bucket — the main account |
| `marcus.reid@example.com`   | Seller with one clean payout ready to withdraw           |
| `tom.becker@example.com`    | Buyer with two unpaid invoices                           |
| `priya.nair@example.com`    | Empty wallet — good for showing a balance fill up        |
| `ADMIN_EMAILS[0]`           | The admin who resolves `dsp_open_1`                      |

### The three switches

| Env                    | Demo value | What it does                                                                                                                                              |
| ---------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VESTING_DAYS`         | `0`        | New payments vest instantly (`vestedAt = paidAt`), so a purchase is withdrawable the second the webhook lands. **Only affects orders paid from now on** — seeded `vestedAt` values are fixed, so the vesting spread stays visible in the wallet table. |
| `OXAPAY_MOCK`          | `true`     | No live OxaPay calls. Invoices get a fake `track_id` and a `paymentUrl` pointing at the built-in mock checkout; payouts get a fake track id. Also mounts `/api/dev/*`. |
| `DEV_AUTH_BYPASS`      | `true`     | Accept `x-dev-user-email: <email>` instead of a Clerk bearer token. Also mounts `/api/dev/*`. Ignored when `NODE_ENV=production`.                          |

Both dev switches are inert in production: `DevModule` and the bypass check
`NODE_ENV !== 'production'` before doing anything.

The mock checkout at `GET /api/dev/mock-pay/:orderId` is a real page with two buttons. It
builds an OxaPay-shaped callback, signs it with the merchant key and POSTs it to the real
webhook — so the HMAC check, the idempotency guard and the vesting maths are all genuinely
exercised, not stubbed. `POST /api/dev/mock-payout/:withdrawalId` does the same for payouts.

Live-payment demo instead of mock: set `OXAPAY_MOCK=false`, `OXAPAY_SANDBOX=true`, run
`ngrok http 3000` and put the ngrok URL in `PUBLIC_API_URL` — OxaPay cannot call localhost.

### Two-minute happy path

Run with `VESTING_DAYS=0 OXAPAY_MOCK=true DEV_AUTH_BYPASS=true`. Everything below is
clickable from `/docs` — hit **Authorize**, put the e-mail in the `dev-bypass` box.

1. **Browse** — `GET /api/listings` (no auth at all). 8 listings. Point out that
   `deliveryInfo` is not in the payload.
2. **Buy** — as `tom.becker@example.com`: `POST /api/orders { "listingId": "lst_adobe" }`.
   Order is `PENDING_PAYMENT`, response carries `paymentUrl`.
3. **Simulate payment** — open that `paymentUrl` and click *Simulate payment*. The webhook
   flips the order to `PAID` and sets `paidAt` / `vestedAt` (identical, because
   `VESTING_DAYS=0`).
4. **Buyer gets the goods** — as Tom: `GET /api/orders/{id}` now includes `deliveryInfo`.
   It did not a moment ago, and it never does for the seller.
5. **Seller balance** — as `priya.nair@example.com` (she sells `lst_adobe`):
   `GET /api/wallet/balance` → the money is in `available` immediately.
6. **Withdraw** — as Priya: `POST /api/wallet/withdraw { "address": "...", "network": "TRC20" }`.
   No amount parameter: it pays out the whole `available` bucket. Balance moves to
   `withdrawing`. Then `POST /api/dev/mock-payout/{id} { "status": "completed" }` moves it
   to `withdrawn`.
7. **Vesting is per order** — as `elena.petrova@example.com`: `GET /api/wallet/orders`.
   Some orders are `available`, some still `vesting` with different dates, one is
   `disputed` and one is already `withdrawn`. This is the escrow story in one table.
8. **Dispute** — the seeded `dsp_open_1` is already `OPEN` on `ord_disputed_1`, and Elena's
   `$16.62` sits in `disputed`, frozen even though it will vest. (To open a fresh one live:
   as the buyer, `POST /api/orders/{id}/dispute { "reason": "..." }` — it returns a Telegram
   invite link, or `null` if Telegram is not configured, which never blocks the dispute.)
9. **Admin resolves** — as the admin: `GET /api/admin/disputes?status=OPEN`, then
   `POST /api/admin/disputes/dsp_open_1/resolve { "winner": "BUYER" }`. Refresh both wallets:
   the money left Elena's `disputed` bucket and appeared in Priya's `available` one,
   withdrawable right away. No OxaPay refund call — the buyer withdraws like a seller.
10. **Auto-buy** — as Tom: `GET /api/buy-requests/mine` shows a `MATCHED` wish with a live
    payment link (`ord_autobuy_1`, `lst_midjourney` is `RESERVED`) and an `ACTIVE` one for
    Disney+. Pay the matched order at `/api/dev/mock-pay/ord_autobuy_1` → wish `FULFILLED`,
    listing `SOLD`, Marcus's wallet fills like any sale. Or list Disney+ 12m under $100 as
    any seller → an order + payment link appear for Tom automatically, the listing goes
    `RESERVED`. Left unpaid, the minute-cron expires the reservation and re-arms everything.
11. **Numbers** — `GET /api/admin/stats` for the closing slide.

If Telegram is configured, step 8's group is created for the admins + bot, and step 9 posts
the outcome into it. If it isn't, everything above still works; the invite link is `null`.
`POST /api/admin/disputes/{id}/telegram-retry` creates the group afterwards.

---

## 13. Build order (follow this)

1. Scaffold: Nest app, Prisma, docker-compose, config + env validation, `/api/health`, Swagger.
2. Full `schema.prisma` + first migration + seed (admin + 3 listings).
3. `ClerkAuthGuard` + `@Public()` + `@CurrentUser()` + `GET/PATCH /api/me`.
4. Listings CRUD.
5. `OxaPayService.createInvoice` + `POST /api/orders` + orders read endpoints.
6. Payment webhook (raw body, HMAC, idempotency) → sets `PAID` + `vestedAt`. **Test with ngrok now.**
7. `WalletService.getWithdrawableOrders` + `GET /api/wallet/balance`.
8. `POST /api/wallet/withdraw` + `OxaPayService.createPayout` + payout webhook.
9. Disputes: create + Telegram topic + block withdrawals.
10. Admin: list disputes + resolve (BUYER / SELLER) + stats.
11. Demo polish: `VESTING_DAYS=0` path, better error messages, Swagger tags.

---

## 14. Conventions

- Errors: throw Nest exceptions (`BadRequestException`, `ForbiddenException`, `NotFoundException`)
  with short human messages the FE can display directly.
- Never leak `deliveryInfo` of a listing to anyone but the buyer of a paid order.
- Every money mutation goes through a Prisma `$transaction`.
- Return `Decimal` as **strings** in JSON (`amountUsd: "12.50"`) — configure a serializer or
  `.toFixed(2)` in the mapper. Never send floats to the FE.
- All timestamps are ISO-8601 UTC.
- Log every OxaPay request/response and every webhook body with `Logger` — during a hackathon demo
  this is the only debugging you'll get.