# CLAUDE.md — SeatShare Backend

Guidance for Claude Code when working in this repository.

---

## 1. What this project is

**SeatShare** is a marketplace for shared subscription seats. A user (the **seller**) owns or is willing to open a group subscription plan — YouTube Premium Family, Spotify Duo/Family, Netflix, etc. — and posts a listing offering the remaining seats. Other users (the **buyers**) claim those seats and pay in crypto. The platform holds the money in escrow, releases it to the seller gradually over the subscription period, and takes a **4% fee**.

Single-seat items (ChatGPT Plus, a Netflix account handover, etc.) are the same flow with `totalSeats = 1`.

**This is a hackathon project.** Optimize for a working demo, not for production hardening. When in doubt, pick the simpler option and leave a `// TODO(post-hackathon):` comment.

### Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 20+, TypeScript (strict) |
| Framework | NestJS 10 |
| ORM | Prisma |
| DB | PostgreSQL 16 |
| Auth | Clerk (Google OAuth only for now) |
| Payments | OxaPay (crypto) |
| Jobs | `@nestjs/schedule` (in-process cron — no Redis, no BullMQ) |
| Validation | `class-validator` + `class-transformer` |
| Docs | `@nestjs/swagger` at `/docs` |
| Frontend | React (separate repo/folder — not our concern here) |

### Non-goals for the hackathon

Do not build these unless explicitly asked:

- Automated crypto payouts (withdrawals are **requested** in-app, an admin marks them sent manually)
- Automated crypto refunds (refunds credit the buyer's **internal wallet balance**)
- KYC, email/SMS notifications, ratings & reviews, chat outside disputes
- Multi-currency accounting (everything is denominated in **USD cents**)
- Rate limiting, caching, horizontal scaling, comprehensive test suites

---

## 2. Domain model in plain language

Read this before touching money code. Every bug in this project will be a money bug.

### The lifecycle of a listing

1. A seller creates a **Listing**: service name, `totalSeats`, `pricePerSeat`, `durationDays` (how long the plan lasts, e.g. 30), and a `fillDeadline` (the date by which all seats must be sold).
2. Buyers create **Orders** against the listing. Each order reserves one seat and creates an OxaPay invoice. The reservation has a short TTL (default 30 minutes) — if unpaid by then, the seat is freed.
3. Money from a paid order goes into **escrow**, held by the platform. Nobody can touch it yet.
4. **Path A — the listing fills before the deadline.** The listing goes `ACTIVE`. The seller delivers the invites. All escrows convert from `HELD` to `VESTING`: the seller's `lockedBalanceCents` goes up by the net amount (gross − 4% fee), and the fee is recorded to the platform.
5. **Path B — the deadline passes with unsold seats.** The listing goes `EXPIRED`. Every escrow is refunded **in full, with no fee deducted** — the buyer gets back exactly what they paid, credited to their in-app wallet.
6. When the vesting period ends (`activatedAt + durationDays`), the escrow is `RELEASED` and the seller's money moves from `lockedBalanceCents` to `availableBalanceCents`. Only then can it be withdrawn.
7. At any point during an active order, either side can open a **Dispute**. Opening a dispute **freezes** that order's escrow so vesting cannot release it. An admin resolves the dispute in favour of the buyer, the seller, or a split.

### The 4% fee

- Constant: `PLATFORM_FEE_BPS = 400` (basis points). Snapshotted onto every order as `platformFeeBps` so historical orders stay correct if the rate changes.
- `feeCents = Math.round(amountCents * platformFeeBps / 10_000)`
- `netCents = amountCents - feeCents`
- **The buyer always pays the sticker price.** The fee comes out of the seller's payout.
- **No fee is taken on a refund.** If a listing expires unfilled or an admin rules for the buyer, the buyer is made whole for the full gross amount and the platform earns nothing.

### Why vesting exists

The seller could remove a buyer from the family plan on day 2 and walk away with 30 days of money. Vesting means the seller's funds unlock only after the plan period they sold has actually elapsed, which gives the buyer a window to open a dispute against money that is still recoverable.

For the demo, `VESTING_SPEEDUP` in env lets you compress "30 days" into "30 seconds". Use it.

---

## 3. Money handling rules

**Non-negotiable. Violating any of these is a bug even if tests pass.**

1. **All money is `Int` cents, USD.** Never `Float`, never `Decimal`, never a JS `number` holding dollars. Field names always end in `Cents`. The API accepts and returns cents; the React frontend formats for display.
2. **The `Ledger` table is the source of truth.** `Wallet.availableBalanceCents` and `Wallet.lockedBalanceCents` are denormalized caches. Every single balance mutation writes a `Ledger` row *and* updates the wallet **inside the same Prisma `$transaction`**. There is no code path that changes a wallet without a matching ledger entry.
3. **Ledger entries are append-only.** Never update or delete a `Ledger` row. Corrections are new, opposite-signed rows.
4. **Every ledger entry's sum must be zero across parties.** Money moving to a seller comes out of escrow; a fee moves to the platform account (`userId = null`). If you write one row you almost certainly owe another.
5. **Webhooks are idempotent.** Every OxaPay callback is written to `WebhookEvent` with a unique `(provider, externalId, status)` key first. If the insert conflicts, return 200 immediately and do nothing else. OxaPay retries up to 5 times and sends `paying` before `paid`.
6. **Seat reservation is race-sensitive.** Creating an order must lock the listing row: inside a transaction, run `SELECT ... FOR UPDATE` on the listing (Prisma: `$queryRaw` with `FOR UPDATE`), recount live orders, and only then insert. Two buyers clicking simultaneously on the last seat must not both succeed.
7. **Never trust the amount in a webhook payload for authorization.** Look the order up by your own `orderId`, compare the paid amount to the expected amount, and reject/flag underpayments rather than silently accepting.

---

## 4. Database schema (Prisma)

Full `prisma/schema.prisma`. Table names are snake_case via `@@map`; TS field names stay camelCase.

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ─────────────────────────── enums ───────────────────────────

enum Role {
  USER
  ADMIN
}

enum ListingType {
  GROUP   // multiple seats, e.g. YouTube Premium Family
  SINGLE  // exactly one seat, e.g. ChatGPT Plus
}

enum ListingStatus {
  OPEN        // accepting orders
  FILLED      // all seats paid, awaiting seller delivery
  ACTIVE      // delivered; vesting clock running
  COMPLETED   // vesting finished, all escrows released
  EXPIRED     // fillDeadline passed unfilled -> everything refunded
  CANCELLED   // seller or admin cancelled -> everything refunded
}

enum OrderStatus {
  PENDING_PAYMENT  // invoice created, seat reserved with TTL
  PAID             // funds in escrow, waiting for the listing to fill
  ACTIVE           // listing active, seat delivered/deliverable
  COMPLETED        // vesting done, seller paid out
  DISPUTED         // dispute open on this order, escrow frozen
  REFUNDED         // buyer made whole
  EXPIRED          // reservation TTL elapsed without payment
  CANCELLED        // buyer cancelled before paying
}

enum PaymentStatus {
  NEW
  WAITING     // OxaPay "waiting" — invoice created, nothing received
  CONFIRMING  // OxaPay "paying"/"confirming" — tx seen, not final
  PAID
  UNDERPAID
  EXPIRED
  FAILED
}

enum EscrowStatus {
  HELD      // buyer paid, listing not yet active
  VESTING   // listing active, funds locked on the seller's wallet
  FROZEN    // dispute open, release blocked
  RELEASED  // seller can withdraw
  REFUNDED  // returned to the buyer
}

enum DisputeStatus {
  OPEN
  UNDER_REVIEW
  RESOLVED_BUYER   // full refund to buyer
  RESOLVED_SELLER  // funds continue vesting / release to seller
  RESOLVED_SPLIT   // partial refund
  CANCELLED        // withdrawn by the opener
}

enum DisputeReason {
  SEAT_NOT_DELIVERED
  SEAT_REVOKED
  CREDENTIALS_INVALID
  SERVICE_NOT_AS_DESCRIBED
  BUYER_ABUSE
  OTHER
}

enum LedgerType {
  ESCROW_IN            // buyer's payment enters platform escrow
  PLATFORM_FEE         // 4% to the platform account
  VEST_LOCK            // net amount locked on the seller's wallet
  VEST_RELEASE         // locked -> available on the seller's wallet
  REFUND_CREDIT        // gross credited to the buyer's available balance
  PAYOUT_DEBIT         // available -> outgoing withdrawal
  PAYOUT_REVERSAL      // rejected withdrawal returned
  DISPUTE_ADJUSTMENT   // admin-driven correction
}

enum BalanceBucket {
  AVAILABLE
  LOCKED
  ESCROW    // platform-held, not attributable to a user wallet yet
}

enum PayoutStatus {
  REQUESTED
  APPROVED
  SENT
  REJECTED
}

// ─────────────────────────── core ───────────────────────────

model User {
  id          String   @id @default(uuid())
  clerkId     String   @unique
  email       String   @unique
  displayName String?
  avatarUrl   String?
  role        Role     @default(USER)
  bannedAt    DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  wallet            Wallet?
  listings          Listing[]        @relation("SellerListings")
  orders            Order[]          @relation("BuyerOrders")
  ledgerEntries     Ledger[]
  payouts           Payout[]
  disputesOpened    Dispute[]        @relation("DisputeOpener")
  disputesAgainst   Dispute[]        @relation("DisputeRespondent")
  disputesResolved  Dispute[]        @relation("DisputeResolver")
  disputeMessages   DisputeMessage[]

  @@map("users")
}

model Wallet {
  id                   String   @id @default(uuid())
  userId               String   @unique
  availableBalanceCents Int     @default(0)  // withdrawable
  lockedBalanceCents    Int     @default(0)  // vesting, not yet withdrawable
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("wallets")
}

model Listing {
  id             String        @id @default(uuid())
  sellerId       String
  title          String
  description    String?
  serviceName    String        // free text: "YouTube Premium Family", "ChatGPT Plus"
  serviceSlug    String        // normalized for filtering: "youtube-premium"
  type           ListingType
  totalSeats     Int           // always 1 when type = SINGLE
  pricePerSeatCents Int
  durationDays   Int           // plan length -> drives the vesting window
  fillDeadline   DateTime      // all seats must be sold by this moment
  status         ListingStatus @default(OPEN)

  activatedAt DateTime?  // set when the listing fills and the seller delivers
  expiresAt   DateTime?  // activatedAt + durationDays
  cancelledAt DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  seller   User      @relation("SellerListings", fields: [sellerId], references: [id])
  orders   Order[]
  escrows  Escrow[]
  disputes Dispute[]

  @@index([status, fillDeadline])
  @@index([serviceSlug, status])
  @@index([sellerId])
  @@map("listings")
}

model Order {
  id        String      @id @default(uuid())
  listingId String
  buyerId   String
  status    OrderStatus @default(PENDING_PAYMENT)

  // price snapshot — never read the live listing price for an existing order
  amountCents     Int
  platformFeeBps  Int @default(400)
  feeCents        Int
  netCents        Int

  reservationExpiresAt DateTime  // now + ORDER_RESERVATION_MINUTES
  paidAt               DateTime?

  // seat delivery
  buyerContact String?   // email/handle the seller should invite
  deliveredAt  DateTime? // seller marked as delivered
  confirmedAt  DateTime? // buyer confirmed receipt (informational only)
  deliveryNote String?   // invite link or instructions from the seller

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  listing  Listing   @relation(fields: [listingId], references: [id])
  buyer    User      @relation("BuyerOrders", fields: [buyerId], references: [id])
  payment  Payment?
  escrow   Escrow?
  disputes Dispute[]

  // one live claim per buyer per listing; enforce the "live" part in code
  @@unique([listingId, buyerId])
  @@index([status, reservationExpiresAt])
  @@index([buyerId])
  @@map("orders")
}

model Payment {
  id       String        @id @default(uuid())
  orderId  String        @unique
  provider String        @default("OXAPAY")
  status   PaymentStatus @default(NEW)

  providerTrackId String? @unique  // OxaPay track_id
  payLink         String?

  amountRequestedCents Int
  amountPaidCents      Int     @default(0)
  payCurrency          String? // e.g. "USDT", "BTC"
  txHash               String?

  expiresAt DateTime?
  paidAt    DateTime?
  rawPayload Json?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  order Order @relation(fields: [orderId], references: [id])

  @@map("payments")
}

model Escrow {
  id        String       @id @default(uuid())
  orderId   String       @unique
  listingId String
  buyerId   String
  sellerId  String
  status    EscrowStatus @default(HELD)

  grossCents Int
  feeCents   Int
  netCents   Int

  vestingStartsAt DateTime?
  vestingEndsAt   DateTime?
  releasedAt      DateTime?
  refundedAt      DateTime?
  refundedCents   Int      @default(0)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  order   Order   @relation(fields: [orderId], references: [id])
  listing Listing @relation(fields: [listingId], references: [id])

  @@index([status, vestingEndsAt])
  @@index([sellerId])
  @@map("escrows")
}

model Ledger {
  id     String        @id @default(uuid())
  userId String?       // null = the platform's own account (fees)
  type   LedgerType
  bucket BalanceBucket
  // signed: positive = into this bucket, negative = out of it
  amountCents Int

  refType String? // "order" | "escrow" | "payout" | "dispute"
  refId   String?
  memo    String?

  createdAt DateTime @default(now())

  user User? @relation(fields: [userId], references: [id])

  @@index([userId, createdAt])
  @@index([refType, refId])
  @@map("ledger_entries")
}

model Dispute {
  id        String        @id @default(uuid())
  orderId   String
  listingId String
  openedById String
  againstId  String
  reason    DisputeReason
  status    DisputeStatus @default(OPEN)
  description String

  resolvedById  String?
  resolvedAt    DateTime?
  resolutionNote String?
  refundCents   Int       @default(0) // amount returned to the buyer on resolution

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  order      Order            @relation(fields: [orderId], references: [id])
  listing    Listing          @relation(fields: [listingId], references: [id])
  openedBy   User             @relation("DisputeOpener", fields: [openedById], references: [id])
  against    User             @relation("DisputeRespondent", fields: [againstId], references: [id])
  resolvedBy User?            @relation("DisputeResolver", fields: [resolvedById], references: [id])
  messages   DisputeMessage[]

  @@index([status, createdAt])
  @@index([orderId])
  @@map("disputes")
}

model DisputeMessage {
  id        String   @id @default(uuid())
  disputeId String
  authorId  String
  body      String
  attachments Json?  // [{ url, filename }] — URLs only, no uploads for the hackathon
  isInternal Boolean @default(false) // admin-only note, hidden from the parties
  createdAt DateTime @default(now())

  dispute Dispute @relation(fields: [disputeId], references: [id], onDelete: Cascade)
  author  User    @relation(fields: [authorId], references: [id])

  @@index([disputeId, createdAt])
  @@map("dispute_messages")
}

model Payout {
  id     String       @id @default(uuid())
  userId String
  amountCents Int
  status PayoutStatus @default(REQUESTED)

  address  String  // crypto address supplied by the user
  network  String  // "TRC20", "ERC20", "BTC", ...
  txHash   String?
  adminNote String?

  processedById String?
  processedAt   DateTime?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  user User @relation(fields: [userId], references: [id])

  @@index([status, createdAt])
  @@map("payouts")
}

model WebhookEvent {
  id         String   @id @default(uuid())
  provider   String   @default("OXAPAY")
  externalId String   // OxaPay track_id
  status     String   // payload status, so "paying" and "paid" are distinct events
  payload    Json
  processedAt DateTime?
  error      String?
  createdAt  DateTime @default(now())

  @@unique([provider, externalId, status])
  @@map("webhook_events")
}
```

---

## 5. State machines

Implement these as explicit guard functions in each module's service (e.g. `assertTransition(from, to)`). Do not scatter status checks through controllers.

### Listing

```
OPEN ──(all seats paid)──────────> FILLED ──(seller delivers)──> ACTIVE
 │                                   │                             │
 │                                   └──(admin/seller cancel)──┐    └──(vesting done on all escrows)──> COMPLETED
 │                                                             │
 ├──(fillDeadline passed, unfilled)──> EXPIRED                 └──> CANCELLED
 └──(seller cancels, no paid orders)─> CANCELLED
```

`EXPIRED` and `CANCELLED` both trigger a full refund of every `HELD` escrow.

### Order

```
PENDING_PAYMENT ──(webhook paid)──> PAID ──(listing ACTIVE)──> ACTIVE ──(vesting released)──> COMPLETED
      │                              │                           │
      │                              └──(listing EXPIRED/CANCELLED)──> REFUNDED
      ├──(TTL elapsed)──> EXPIRED    │                           │
      └──(buyer cancels)──> CANCELLED└───────────────────────────┴──(dispute opened)──> DISPUTED
                                                                              │
                                                        ┌─────────────────────┴──────────────────┐
                                                   RESOLVED_BUYER                          RESOLVED_SELLER
                                                    -> REFUNDED                         -> ACTIVE/COMPLETED
```

### Escrow

```
HELD ──(listing ACTIVE)──> VESTING ──(vestingEndsAt passed)──> RELEASED
  │                           │
  │                           ├──(dispute opened)──> FROZEN ──(admin resolves)──> RELEASED | REFUNDED
  └──(listing EXPIRED/CANCELLED)────────────────────> REFUNDED
```

---

## 6. Money flows, step by step

Each numbered block is one Prisma `$transaction`. Write them exactly like this.

### 6.1 Buyer pays (webhook `status = paid`)

```
order.status              PENDING_PAYMENT -> PAID
order.paidAt              = now
payment.status            -> PAID
escrow created            status = HELD, gross/fee/net snapshotted from the order

Ledger:
  { userId: null, type: ESCROW_IN, bucket: ESCROW, amount: +gross, ref: escrow }
```

Then, still inside the same transaction, recount paid orders. If `paidCount === listing.totalSeats`, move the listing to `FILLED`.

### 6.2 Listing activates (seller delivers, or auto-activate on fill)

```
listing.status     FILLED -> ACTIVE
listing.activatedAt = now
listing.expiresAt   = now + durationDays

for each escrow where status = HELD:
  escrow.status          -> VESTING
  escrow.vestingStartsAt = listing.activatedAt
  escrow.vestingEndsAt   = listing.expiresAt
  order.status           PAID -> ACTIVE
  seller.wallet.lockedBalanceCents += net

  Ledger:
    { userId: null,     type: ESCROW_IN,    bucket: ESCROW,  amount: -gross }
    { userId: null,     type: PLATFORM_FEE, bucket: AVAILABLE, amount: +fee  }  // platform account
    { userId: sellerId, type: VEST_LOCK,    bucket: LOCKED,  amount: +net   }
```

### 6.3 Vesting releases (cron)

```
escrow.status  VESTING -> RELEASED   (skip anything FROZEN)
escrow.releasedAt = now
order.status   ACTIVE -> COMPLETED
seller.wallet.lockedBalanceCents    -= net
seller.wallet.availableBalanceCents += net

Ledger:
  { userId: sellerId, type: VEST_RELEASE, bucket: LOCKED,    amount: -net }
  { userId: sellerId, type: VEST_RELEASE, bucket: AVAILABLE, amount: +net }
```

When the last escrow on a listing releases, set `listing.status = COMPLETED`.

### 6.4 Deadline missed — refund with no fee (cron)

```
listing.status OPEN -> EXPIRED

for each escrow where status = HELD:
  escrow.status        -> REFUNDED
  escrow.refundedCents = gross          // full gross, fee NOT deducted
  order.status         -> REFUNDED
  buyer.wallet.availableBalanceCents += gross

  Ledger:
    { userId: null,    type: ESCROW_IN,     bucket: ESCROW,    amount: -gross }
    { userId: buyerId, type: REFUND_CREDIT, bucket: AVAILABLE, amount: +gross }
```

No `PLATFORM_FEE` row is ever written on this path.

### 6.5 Dispute resolution

- **`RESOLVED_SELLER`** — unfreeze: `escrow.status FROZEN -> VESTING`, order back to `ACTIVE`. Normal vesting resumes.
- **`RESOLVED_BUYER`** — full `net` comes off the seller's locked balance, `gross` is credited to the buyer, and the platform gives back its `fee`:

```
escrow.status -> REFUNDED
seller.wallet.lockedBalanceCents -= net
buyer.wallet.availableBalanceCents += gross

Ledger:
  { userId: sellerId, type: DISPUTE_ADJUSTMENT, bucket: LOCKED,    amount: -net   }
  { userId: null,     type: DISPUTE_ADJUSTMENT, bucket: AVAILABLE, amount: -fee   }  // fee reversed
  { userId: buyerId,  type: DISPUTE_ADJUSTMENT, bucket: AVAILABLE, amount: +gross }
```

- **`RESOLVED_SPLIT`** — admin supplies `refundCents` (must be `0 < refundCents < gross`). Refund that much to the buyer from the seller's locked balance; the remainder keeps vesting. Keep the fee proportional: `keptFee = round(fee * (gross - refundCents) / gross)`.

Guard: if `seller.wallet.lockedBalanceCents < amountToClaw`, clamp to what is available and write an `adminNote`. Log loudly. This should not happen — vesting must never release a frozen escrow.

---

## 7. File structure

```
backend/
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts                      # demo users, listings, an admin
├── src/
│   ├── main.ts                      # bootstrap, CORS, ValidationPipe, Swagger, raw-body for webhooks
│   ├── app.module.ts
│   │
│   ├── config/
│   │   ├── configuration.ts         # typed config factory
│   │   └── env.validation.ts        # Joi/zod schema — fail fast on boot
│   │
│   ├── prisma/
│   │   ├── prisma.module.ts         # @Global
│   │   └── prisma.service.ts
│   │
│   ├── common/
│   │   ├── constants.ts             # PLATFORM_FEE_BPS, ORDER_RESERVATION_MINUTES
│   │   ├── decorators/
│   │   │   ├── current-user.decorator.ts
│   │   │   ├── public.decorator.ts       # @Public() skips the auth guard
│   │   │   └── roles.decorator.ts
│   │   ├── guards/
│   │   │   ├── clerk-auth.guard.ts       # global guard
│   │   │   └── roles.guard.ts
│   │   ├── filters/
│   │   │   └── all-exceptions.filter.ts
│   │   ├── interceptors/
│   │   │   └── logging.interceptor.ts
│   │   └── dto/
│   │       └── pagination.dto.ts
│   │
│   ├── modules/
│   │   ├── auth/
│   │   │   ├── auth.module.ts
│   │   │   ├── auth.service.ts           # verify Clerk JWT, JIT-provision the local User
│   │   │   └── auth.controller.ts        # GET /me
│   │   │
│   │   ├── users/
│   │   │   ├── users.module.ts
│   │   │   ├── users.service.ts
│   │   │   ├── users.controller.ts
│   │   │   └── dto/update-profile.dto.ts
│   │   │
│   │   ├── listings/
│   │   │   ├── listings.module.ts
│   │   │   ├── listings.service.ts
│   │   │   ├── listings.controller.ts
│   │   │   ├── listing-state.ts          # transition guards
│   │   │   └── dto/
│   │   │       ├── create-listing.dto.ts
│   │   │       ├── update-listing.dto.ts
│   │   │       └── query-listings.dto.ts
│   │   │
│   │   ├── orders/
│   │   │   ├── orders.module.ts
│   │   │   ├── orders.service.ts         # seat reservation w/ row lock
│   │   │   ├── orders.controller.ts
│   │   │   └── dto/
│   │   │       ├── create-order.dto.ts
│   │   │       └── deliver-seat.dto.ts
│   │   │
│   │   ├── payments/
│   │   │   ├── payments.module.ts
│   │   │   ├── payments.service.ts
│   │   │   ├── payments.controller.ts
│   │   │   ├── webhooks.controller.ts    # POST /webhooks/oxapay
│   │   │   └── oxapay/
│   │   │       ├── oxapay.client.ts      # HTTP wrapper
│   │   │       ├── oxapay.types.ts
│   │   │       └── oxapay.hmac.ts        # sha512 raw-body verification
│   │   │
│   │   ├── escrow/
│   │   │   ├── escrow.module.ts
│   │   │   ├── escrow.service.ts         # HELD/VESTING/FROZEN/RELEASED/REFUNDED
│   │   │   └── ledger.service.ts         # THE ONLY place that mutates wallets
│   │   │
│   │   ├── wallet/
│   │   │   ├── wallet.module.ts
│   │   │   ├── wallet.service.ts
│   │   │   ├── wallet.controller.ts
│   │   │   └── dto/request-payout.dto.ts
│   │   │
│   │   ├── disputes/
│   │   │   ├── disputes.module.ts
│   │   │   ├── disputes.service.ts
│   │   │   ├── disputes.controller.ts
│   │   │   └── dto/
│   │   │       ├── create-dispute.dto.ts
│   │   │       ├── post-message.dto.ts
│   │   │       └── resolve-dispute.dto.ts
│   │   │
│   │   ├── admin/
│   │   │   ├── admin.module.ts
│   │   │   ├── admin.controller.ts       # @Roles(ADMIN) on the whole controller
│   │   │   └── admin.service.ts          # stats, dispute queue, payout queue
│   │   │
│   │   └── jobs/
│   │       ├── jobs.module.ts
│   │       └── jobs.service.ts           # all four crons live here
│   │
│   └── types/
│       └── express.d.ts                  # req.user augmentation
├── test/
│   └── money-flow.e2e-spec.ts            # one happy path + one refund path, if time allows
├── .env.example
├── docker-compose.yml                    # postgres only
├── nest-cli.json
├── tsconfig.json
└── package.json
```

### Module dependency rules

- `LedgerService` is the **only** class allowed to write `Ledger` rows or touch `Wallet` balances. Everything else calls it.
- `EscrowService` owns escrow status transitions and calls `LedgerService`.
- `PaymentsService` never touches wallets directly — it flips payment/order status and calls `EscrowService`.
- `JobsService` calls into `ListingsService`, `OrdersService`, and `EscrowService`. It contains no business logic itself, only scheduling and iteration.
- No circular imports. If two modules need each other, the shared logic belongs in `escrow/`.

---

## 8. Auth (Clerk)

- Frontend gets a session JWT from Clerk and sends `Authorization: Bearer <token>`.
- `ClerkAuthGuard` is registered globally via `APP_GUARD`. It verifies the token with `verifyToken` from `@clerk/backend` using `CLERK_SECRET_KEY`.
- On success, look up `User` by `clerkId`. **JIT-provision**: if not found, create the `User` and its `Wallet` in one transaction, pulling email/name/avatar from the Clerk claims.
- Attach the local `User` (not the Clerk object) to `req.user`. `@CurrentUser()` returns it.
- Mark public routes with `@Public()`: `GET /health`, `POST /webhooks/oxapay`, `GET /listings`, `GET /listings/:id`.
- **Roles live in our DB, not in Clerk.** Seed admins from `ADMIN_EMAILS` (comma-separated) in `prisma/seed.ts`. `RolesGuard` reads `user.role`.
- The admin panel is a route group in the same React app; there is no separate admin auth. `@Roles(Role.ADMIN)` is the only gate.

---

## 9. OxaPay integration

> OxaPay's API has both a legacy and a v1 surface. Use **v1**. If a request 404s or the response shape differs from what's below, check https://docs.oxapay.com/api-reference before improvising.

### Creating an invoice

`POST https://app-api.oxapay.com/v1/payment/invoice`

Headers: `merchant_api_key: <OXAPAY_MERCHANT_KEY>`, `Content-Type: application/json`

```json
{
  "amount": 12.5,
  "currency": "USD",
  "lifetime": 30,
  "fee_paid_by_payer": 1,
  "order_id": "<our Order.id>",
  "callback_url": "https://<PUBLIC_URL>/webhooks/oxapay",
  "return_url": "https://<FRONTEND_URL>/orders/<orderId>",
  "description": "Seat in <listing.title>",
  "sandbox": true
}
```

Response gives a `track_id` and a `payment_url`. Store them on `Payment.providerTrackId` / `Payment.payLink` and return `payLink` to the frontend.

- `amount` is in **dollars** (a float), so convert: `amountCents / 100`. This is the only place dollars are allowed.
- `fee_paid_by_payer: 1` so OxaPay's network fee doesn't eat into our 4%.
- Always send `sandbox: true` in dev — driven by `OXAPAY_SANDBOX` in env.

### Webhook

`POST /webhooks/oxapay`, `application/json`.

1. **Raw body is required.** In `main.ts`, enable `rawBody: true` on the Nest app and read `req.rawBody` in the controller. Verifying HMAC against a re-serialized body will fail.
2. Verify: `crypto.createHmac('sha512', OXAPAY_MERCHANT_KEY).update(rawBody).digest('hex')` must equal the `HMAC` request header. Compare with `crypto.timingSafeEqual`. On mismatch, return **400** and do not process.
3. Insert a `WebhookEvent` on `(provider, externalId, status)`. On unique-constraint conflict, return `200 "ok"` and stop — already handled.
4. Dispatch on status:
   - `waiting` → `Payment.status = WAITING`
   - `paying` / `confirming` → `CONFIRMING`. **This is not payment.** OxaPay sends `paying` first and `paid` later; only act on `paid`.
   - `paid` → verify the amount covers `amountRequestedCents`, then run flow 6.1.
   - `underpaid` → `UNDERPAID`, leave the order in `PENDING_PAYMENT`, surface it to the buyer. Don't auto-resolve.
   - `expired` / `failed` → `EXPIRED` / `FAILED`, free the seat.
5. **Always respond `200` with the body `ok`.** OxaPay treats anything else as a failure and retries up to 5 times.
6. If our own processing throws, still return `200`, but record the error on `WebhookEvent.error` and log it — a retry storm during the demo is worse than a missed event we can replay.

### Local development

OxaPay must be able to reach the callback URL. Run `ngrok http 3000` (or a Cloudflare tunnel) and put the public URL in `PUBLIC_URL`. There is also `POST /admin/payments/:id/simulate-paid`, available only when `NODE_ENV !== 'production'` — **build this early**, it's what makes the demo survive a bad conference wifi.

---

## 10. Cron jobs

All in `jobs.service.ts` with `@Cron`. Every handler must be re-entrant and idempotent — assume it may overlap with itself.

| Job | Schedule | What it does |
|---|---|---|
| `expireStaleOrders` | every minute | `PENDING_PAYMENT` orders past `reservationExpiresAt` → `EXPIRED`, freeing the seat. Skip any with a payment in `CONFIRMING`. |
| `expireUnfilledListings` | every 5 min | `OPEN` listings past `fillDeadline` with `paidSeats < totalSeats` → run flow 6.4. |
| `releaseVestedEscrows` | every 5 min | `VESTING` escrows with `vestingEndsAt <= now` → run flow 6.3. Never touch `FROZEN`. |
| `autoActivateListings` | every 5 min | Safety net: `FILLED` listings whose seller hasn't clicked deliver within `AUTO_ACTIVATE_HOURS` → activate anyway (flow 6.2), so a passive seller can't stall the vesting clock forever. |

For the demo, `VESTING_SPEEDUP_FACTOR` divides `durationDays` when computing `vestingEndsAt` — set it to `2880` and a 30-day plan vests in 15 minutes.

---

## 11. API surface

`GET`/`POST` under `/api/v1`. All authenticated unless marked **public**.

### Health & profile
```
GET    /health                              public
GET    /me
PATCH  /me                                  { displayName?, avatarUrl? }
```

### Listings
```
POST   /listings                            create (seller)
GET    /listings                            public; ?type&serviceSlug&status&q&page&limit
GET    /listings/:id                        public; includes seatsTaken/seatsLeft
GET    /listings/mine                       as seller
PATCH  /listings/:id                        seller only, only while OPEN with zero paid orders
POST   /listings/:id/cancel                 seller only; refunds every HELD escrow
POST   /listings/:id/activate               seller only; FILLED -> ACTIVE, starts vesting
```

`POST /listings` body:
```ts
{
  title: string;
  description?: string;
  serviceName: string;
  type: 'GROUP' | 'SINGLE';
  totalSeats: number;        // must be 1 when type = SINGLE
  pricePerSeatCents: number; // > 0
  durationDays: number;      // 1..365
  fillDeadline: string;      // ISO, must be in the future
}
```

### Orders
```
POST   /listings/:id/orders                 claim a seat -> { order, payLink }
GET    /orders/mine                         as buyer
GET    /orders/incoming                     as seller, across all their listings
GET    /orders/:id                          buyer, seller, or admin
POST   /orders/:id/cancel                   buyer, only while PENDING_PAYMENT
POST   /orders/:id/deliver                  seller; { deliveryNote }
POST   /orders/:id/confirm                  buyer confirms receipt (informational)
```

### Payments
```
POST   /webhooks/oxapay                     public, HMAC-verified, raw body
GET    /orders/:id/payment                  poll status from the frontend
POST   /dev/payments/:id/simulate-paid      non-production only
```

### Wallet
```
GET    /wallet                              { availableBalanceCents, lockedBalanceCents, vestingSchedule[] }
GET    /wallet/ledger                       paginated
POST   /wallet/payouts                      { amountCents, address, network }
GET    /wallet/payouts
```

### Disputes
```
POST   /orders/:id/disputes                 { reason, description }
GET    /disputes/mine                       opened by or against me
GET    /disputes/:id
POST   /disputes/:id/messages               { body, attachments? }
POST   /disputes/:id/cancel                 opener only, while OPEN
```

Rules: a dispute can only be opened on an order in `PAID` or `ACTIVE` state, and only before `escrow.vestingEndsAt + DISPUTE_GRACE_HOURS`. Opening one immediately sets `escrow.status = FROZEN` and `order.status = DISPUTED`. Only one open dispute per order.

### Admin (`@Roles(ADMIN)`)
```
GET    /admin/stats                         GMV, fees collected, open disputes, pending payouts
GET    /admin/disputes                      ?status&page
POST   /admin/disputes/:id/claim            -> UNDER_REVIEW, assigns resolvedById
POST   /admin/disputes/:id/resolve          { outcome, refundCents?, resolutionNote }
GET    /admin/listings                      all statuses
POST   /admin/listings/:id/cancel
GET    /admin/users                         ?q
POST   /admin/users/:id/ban
GET    /admin/payouts                       ?status
POST   /admin/payouts/:id/approve
POST   /admin/payouts/:id/reject            { adminNote } — reverses the debit
POST   /admin/payouts/:id/mark-sent         { txHash }
```

### Response conventions

- Success: the resource itself, or `{ data, meta: { page, limit, total } }` for lists.
- Errors: Nest's standard shape via `AllExceptionsFilter` — `{ statusCode, message, error, code? }`. Use a machine-readable `code` for anything the frontend branches on: `SEATS_SOLD_OUT`, `LISTING_NOT_OPEN`, `DUPLICATE_ORDER`, `INSUFFICIENT_BALANCE`, `DISPUTE_WINDOW_CLOSED`.
- Never leak another user's email or Clerk ID. Public listing responses expose only `{ id, displayName, avatarUrl }` for the seller.

---

## 12. Environment variables

```bash
# .env.example
NODE_ENV=development
PORT=3000
PUBLIC_URL=https://your-tunnel.ngrok.app     # OxaPay must reach this
FRONTEND_URL=http://localhost:5173
CORS_ORIGINS=http://localhost:5173

DATABASE_URL=postgresql://postgres:postgres@localhost:5432/seatshare

CLERK_SECRET_KEY=sk_test_xxx
CLERK_PUBLISHABLE_KEY=pk_test_xxx
ADMIN_EMAILS=you@example.com,teammate@example.com

OXAPAY_MERCHANT_KEY=xxxxxx-xxxxxx-xxxxxx-xxxxxx
OXAPAY_SANDBOX=true

PLATFORM_FEE_BPS=400
ORDER_RESERVATION_MINUTES=30
AUTO_ACTIVATE_HOURS=24
DISPUTE_GRACE_HOURS=72
VESTING_SPEEDUP_FACTOR=1                     # set to 2880 for the demo
```

Validate all of these at boot in `env.validation.ts`. A missing `OXAPAY_MERCHANT_KEY` should crash on startup, not at the first payment.

---

## 13. Conventions

- **TypeScript strict mode on.** No `any` in service signatures; `unknown` + a narrowing guard for external payloads.
- **DTOs for every request body**, validated by a global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`.
- **Services hold the logic, controllers stay thin** — parse, delegate, return. No Prisma calls in controllers.
- **Prisma transactions**: use the interactive form `prisma.$transaction(async (tx) => { ... })` and pass `tx` down. Every money-touching service method accepts an optional `tx` parameter so it can compose.
- **Naming**: files `kebab-case.ts`, classes `PascalCase`, DB tables snake_case plural via `@@map`.
- **Dates**: always store and return UTC ISO strings. Never a bare date string.
- **Logging**: use Nest's `Logger` with the class name as context. Every state transition on an order, escrow, or dispute gets an `INFO` log with the ids and the before/after status. This is what you'll be reading at 3am.
- **Comments**: only where the *why* is non-obvious — mostly around the money invariants. Don't narrate the code.

---

## 14. Commands

```bash
npm install
docker compose up -d                 # postgres on :5432
npx prisma migrate dev --name init
npx prisma db seed
npm run start:dev                    # :3000, Swagger at /docs

npx prisma studio                    # inspect the DB during the demo
npx prisma migrate reset             # nuke and reseed

npm run lint
npm run build
```

---

## 15. Build order

Work in this sequence. Each step should leave the app runnable.

1. Nest scaffold, Prisma, Postgres in Docker, `/health` responding.
2. Full `schema.prisma` + initial migration + seed with two users and an admin.
3. Clerk guard, JIT user provisioning, `GET /me`.
4. Listings CRUD + public browse. **Demoable milestone.**
5. Orders with seat reservation and row locking, no payments yet — `simulate-paid` endpoint stands in.
6. `LedgerService` + `EscrowService`: flows 6.1 → 6.4 driven by the simulate endpoint. **This is the core of the project — get it right before touching OxaPay.**
7. Cron jobs with `VESTING_SPEEDUP_FACTOR`.
8. Real OxaPay invoice creation + webhook. Keep `simulate-paid` working as a fallback.
9. Wallet + payout requests.
10. Disputes + admin resolution.
11. Admin stats and queues.

If time runs out, cut in reverse order — items 1–7 alone are a complete, demoable product.

---

## 16. Demo script

The story to tell on stage. Make sure this path never breaks.

1. Seller signs in with Google, posts a YouTube Premium Family listing: 4 seats, $3 each, 30 days, deadline in 24h.
2. Three buyers sign in, claim seats, pay via the OxaPay sandbox. The listing shows 3/4 sold.
3. The fourth buyer pays → listing flips to `FILLED` → seller clicks deliver → `ACTIVE`. The seller's wallet shows **$11.52 locked** ($12 gross − 4% = $0.48 fee) and $0 available.
4. `VESTING_SPEEDUP_FACTOR` makes the 30 days elapse in ~15 minutes; the balance moves from locked to available live on screen.
5. Meanwhile, a second listing's deadline passes with only 2 of 5 seats sold → both buyers see a **full refund with no fee deducted** land in their wallets.
6. One buyer opens a dispute claiming the seat was revoked. The seller's escrow freezes mid-vesting. The admin opens the panel, reads the thread, and rules for the buyer — money moves back, and the platform gives up its fee too.
7. Close on the admin stats page: GMV, total fees collected, disputes resolved.