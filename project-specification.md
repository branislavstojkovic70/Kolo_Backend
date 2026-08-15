# Web Services Marketplace with Crypto Payments - Project Specification

## 1. Overview

A marketplace platform where sellers post ads for web services and buyers pay in
crypto. The platform charges a 4% fee on every payment, holds seller funds in a
vesting period before releasing them (shorter for sellers with better reputation),
and resolves disputes through an admin-mediated process.

**Stack**
- Backend: NestJS
- Frontend: ReactJS
- Database: PostgreSQL
- Payments: OxaPay (crypto payment gateway)

---

## 2. Core Modules

1. Auth (Authentication & Authorization)
2. Users & Reputation
3. Ads (service listings)
4. Orders & Payments (OxaPay integration)
5. Vesting Engine
6. Disputes & Chat
7. Admin Panel
8. Notifications

---

## 3. Module Specifications

### 3.1 Authentication & Authorization

**Goal:** Secure signup/login and role-based access (buyer, seller, admin).

- Email + password registration, email verification required before selling.
- JWT access token (short-lived) + refresh token (httpOnly cookie, rotated on use).
- Password hashing with bcrypt or argon2.
- Roles: `user`, `seller`, `admin`. A `user` becomes a `seller` after completing
  a seller onboarding step (e.g. adding a payout wallet address).
- Optional: 2FA (TOTP) for sellers and mandatory for admins.
- Guards: `JwtAuthGuard`, `RolesGuard` in NestJS, decorated with `@Roles('admin')`
  etc.
- Rate limiting on login/register endpoints (e.g. `@nestjs/throttler`).

**DB tables**
- `users` (id, email, password_hash, role, status, reputation_score, created_at)
- `refresh_tokens` (id, user_id, token_hash, expires_at, revoked)

---

### 3.2 Ads (Service Listings)

**Goal:** Sellers create ads describing the web service they sell.

- Fields: title, description, category, price, delivery_time, revision_count,
  images/attachments, status (`draft`, `active`, `paused`, `removed`).
- Validation: min/max price, required category, profanity/spam filter (basic).
- Sellers can edit ads while in `draft` or `paused`; edits to `active` ads may
  require re-approval depending on your moderation policy.
- Search/filter by category, price range, rating, delivery time.

**DB tables**
- `ads` (id, seller_id, title, description, category_id, price, delivery_days,
  status, created_at, updated_at)
- `ad_images` (id, ad_id, url, position)
- `categories` (id, name, parent_id)

---

### 3.3 Reputation & Vesting

**Goal:** Reward trustworthy sellers with faster access to their funds.

**Reputation score** is a rolling number (e.g. 0-100) computed from:
- Completed orders without dispute (+)
- Disputes lost (--)
- Disputes won (+ small)
- Average buyer rating
- Account age

**Vesting rule (example tiering - adjust to taste):**

| Reputation | Vesting Period |
|---|---|
| 0 - 20 (new/unproven) | 14 days |
| 21 - 50 | 7 days |
| 51 - 80 | 3 days |
| 81 - 100 | 24 hours |

- On order completion (buyer confirms or auto-confirm after X days of
  inactivity), funds move from `escrow` to `vesting` with a `release_at`
  timestamp computed from the seller's reputation tier at that moment.
- A scheduled job (NestJS `@Cron` or a queue worker with BullMQ) checks for
  `vesting` entries past `release_at` and moves them to `available`, which the
  seller can withdraw.
- If a dispute is opened before `release_at`, the vesting entry is frozen
  (`status = frozen`) until the dispute resolves.

**DB tables**
- `wallets` (id, user_id, escrow_balance, vesting_balance, available_balance)
- `vesting_entries` (id, order_id, seller_id, amount, release_at, status)
- `reputation_events` (id, user_id, type, delta, order_id, created_at)

---

### 3.4 Orders & Payments (OxaPay)

**Goal:** Buyer pays for an ad in crypto; platform takes a 4% fee; rest goes to
escrow.

**Flow**
1. Buyer selects an ad, creates an `order` (status `pending_payment`).
2. Backend calls OxaPay's create-invoice API with the order amount.
3. Buyer is redirected to the OxaPay payment page / shown a QR + address.
4. OxaPay sends a webhook (IPN) to your backend on payment confirmation.
5. Webhook handler verifies the signature/hash, marks order as `paid`, splits
   the amount: 4% -> `platform_fee_ledger`, 96% -> seller's `escrow_balance`.
6. Order moves to `in_progress`. Seller delivers. Buyer confirms delivery
   (or auto-confirms after a timeout) -> order moves to `completed`, escrow
   funds move into `vesting_entries` per section 3.3.

**Important implementation notes**
- Never trust the client-side redirect for payment confirmation - only the
  server-to-server webhook confirms payment.
- Store OxaPay's `track_id` on the order and verify webhook payload against it.
- Handle underpayment/overpayment cases per OxaPay's docs (partial payment,
  currency conversion, expired invoice).
- Keep a `payments` audit table separate from `orders` for reconciliation.

**DB tables**
- `orders` (id, buyer_id, seller_id, ad_id, amount, fee_amount, status,
  created_at)
- `payments` (id, order_id, oxapay_track_id, currency, amount_paid, status,
  raw_webhook_payload, created_at)
- `platform_fee_ledger` (id, order_id, amount, created_at)

---

### 3.5 Disputes & Chat

**Goal:** Fair resolution when a buyer claims fraud/non-delivery, including
slashing a fraudulent seller's funds.

**Flow**
1. Buyer or seller opens a dispute on an order (only allowed for orders in
   `in_progress` or within a grace period after `completed`).
2. Dispute creates a dedicated chat room where both parties (and later, the
   admin) exchange messages and can attach evidence (screenshots, files, links).
3. Both parties are prompted to submit their "proof" - a structured statement
   plus attachments.
4. Admin reviews the chat + evidence and makes a decision:
   - **Buyer wins (fraud confirmed):** seller's related `vesting_entry` /
     `escrow_balance` for that order is slashed (moved to a `refunds` record),
     funds returned to buyer's payout, and a negative `reputation_event` is
     recorded for the seller.
   - **Seller wins:** dispute closed, funds proceed through normal vesting.
   - **Partial resolution:** admin can set a custom split.
5. Dispute status: `open` -> `under_review` -> `resolved_buyer` /
   `resolved_seller` / `resolved_partial`.

**Real-time chat:** WebSockets via NestJS Gateway (Socket.IO or native ws),
one room per dispute, persisted to DB.

**DB tables**
- `disputes` (id, order_id, opened_by, reason, status, admin_id, resolution,
  resolved_at)
- `dispute_messages` (id, dispute_id, sender_id, message, attachment_url,
  created_at)
- `dispute_evidence` (id, dispute_id, user_id, description, file_url,
  created_at)

---

### 3.6 Admin Panel

**Goal:** Central control over users, content, and disputes.

- **User management:** view/search users, block/unblock, force logout
  (revoke refresh tokens), manually adjust reputation with an audit reason.
- **Review moderation:** delete or edit any review, restore a deleted review.
- **Ad moderation:** approve/reject/remove ads, feature ads.
- **Dispute queue:** list of open disputes sorted by age/priority, dispute
  detail view showing full chat + evidence + order + payment history, resolve
  action with mandatory admin note (stored for audit).
- **Finance dashboard:** total platform fees collected, funds in escrow vs
  vesting vs available, manual override to release/freeze a vesting entry.
- **Audit log:** every admin action (block user, delete review, resolve
  dispute) is logged with admin_id, action, target, timestamp, reason.

**DB tables**
- `admin_actions` (id, admin_id, action_type, target_type, target_id, reason,
  created_at)
- `reviews` (id, order_id, buyer_id, seller_id, rating, comment, status,
  deleted_by_admin_id)

---

### 3.7 Notifications (supporting module)

- Email + in-app notifications for: payment received, order status change,
  dispute opened/resolved, vesting released, account blocked.
- Queue-based (BullMQ) so webhook handlers stay fast.

---

## 4. Suggested Build Order (Milestones)

1. **Foundation:** NestJS project setup, PostgreSQL + TypeORM/Prisma, user
   auth (register/login/JWT), roles/guards.
2. **Ads:** CRUD for ads, categories, image upload, public listing/search page
   (React).
3. **Payments:** OxaPay integration (invoice creation + webhook handling),
   order lifecycle, escrow ledger, platform fee split.
4. **Reputation & Vesting:** reputation scoring logic, vesting tiers, cron job
   for releasing funds, seller withdrawal flow.
5. **Disputes & Chat:** dispute creation, WebSocket chat, evidence upload,
   admin resolution + slashing logic.
6. **Admin Panel:** user management, review moderation, dispute queue,
   finance dashboard, audit log.
7. **Polish:** notifications, rate limiting, monitoring/logging, tests
   (unit + e2e), deployment.

---

## 5. Key Risks & Open Questions to Decide Early

- What counts as "auto-confirm" delivery timeout if the buyer never responds?
- What currency/currencies does OxaPay settle in, and does the platform hold
  crypto or auto-convert to stablecoin/fiat?
- What is the minimum reputation needed to sell at all (fraud prevention for
  brand-new accounts)?
- Appeals process: can a resolved dispute be reopened?
- Legal/compliance: KYC requirements for large payouts, tax reporting.
