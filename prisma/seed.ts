/**
 * Demo seed — wipes the database and rebuilds a realistic, fully populated dataset.
 *
 *   npx prisma db seed        (or: npm run prisma:seed)
 *
 * Idempotent by construction: it deletes everything first, then recreates with fixed
 * ids, so running it twice gives byte-identical demo data.
 *
 * paidAt / vestedAt are written DIRECTLY here so the vesting spread is visible in the
 * UI immediately — nobody has to wait 30 days. VESTING_DAYS only affects orders that
 * get paid live through the webhook; it is deliberately not applied to seeded rows.
 *
 * Every listing and order is tied to a catalog Product (prisma/products.json) at a
 * sensible discount off retail, and every paid order snapshots the retail price so
 * GET /api/stats/savings has data from the first boot.
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DisputeStatus,
  ListingStatus,
  OrderStatus,
  Prisma,
  PrismaClient,
  Role,
  WithdrawalStatus,
} from '@prisma/client';
import { calcFee, sum, toFixed2 } from '../src/common/money';

const prisma = new PrismaClient();

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.now();
/** days(-45) = 45 days ago, days(28) = 28 days from now */
const days = (n: number) => new Date(T0 + n * DAY);

const FEE_PERCENT = parseFloat(process.env.PLATFORM_FEE_PERCENT ?? '5');
const PUBLIC_API_URL = process.env.PUBLIC_API_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL =
  (process.env.ADMIN_EMAILS ?? '').split(',')[0]?.trim().toLowerCase() ||
  'admin@marketplace.dev';

// --------------------------------------------------------------------- catalog

interface CatalogEntry {
  slug: string;
  name: string;
  category: string;
  retailPriceUsd: string;
  imageUrl?: string;
}

/** Same file ProductsService syncs on boot — the one source of catalog truth. */
const CATALOG = JSON.parse(
  readFileSync(join(__dirname, 'products.json'), 'utf8'),
) as CatalogEntry[];

// ---------------------------------------------------------------------------- users

/** clerkUserId matches what DEV_AUTH_BYPASS generates, so x-dev-user-email adopts these rows. */
const USERS = {
  admin: {
    email: ADMIN_EMAIL,
    username: 'Platform Admin',
    telegramUsername: 'kolo_admin',
    role: Role.ADMIN,
  },
  elena: {
    email: 'elena.petrova@example.com',
    username: 'Elena Petrova',
    telegramUsername: 'elena_digital',
    role: Role.USER,
  },
  marcus: {
    email: 'marcus.reid@example.com',
    username: 'Marcus Reid',
    telegramUsername: 'marcusreid',
    role: Role.USER,
  },
  priya: {
    email: 'priya.nair@example.com',
    username: 'Priya Nair',
    telegramUsername: 'priya_nair',
    role: Role.USER,
  },
  tom: {
    email: 'tom.becker@example.com',
    username: 'Tom Becker',
    telegramUsername: 'tombecker',
    role: Role.USER,
  },
} as const;

type UserKey = keyof typeof USERS;

// ------------------------------------------------------------------------- listings

/**
 * title / category / imageUrl are no longer authored here — they come from the
 * catalog product, exactly like POST /api/listings copies them at write time.
 */
const LISTINGS = [
  {
    id: 'lst_youtube',
    product: 'youtube-premium-12m',
    seller: 'elena' as UserKey,
    description:
      'Family-plan invite for the Google account you already use. Ad-free video, background play and YouTube Music for a full year. No password sharing, nothing to install, works worldwide.',
    quantity: 5,
    priceUsd: '24.99',
    deliveryInfo:
      'Send me the Gmail address on your Google account. The family invite arrives within 30 minutes — accept it and Premium is live instantly.',
    createdDays: -62,
  },
  {
    id: 'lst_spotify',
    product: 'spotify-premium-6m',
    seller: 'elena' as UserKey,
    description:
      'Six prepaid months of Spotify Premium on your existing account. Your playlists, follows and listening history all stay exactly where they are.',
    quantity: 4,
    priceUsd: '17.50',
    deliveryInfo:
      'Redeem code: SPOT-DEMO-6MON-4417. Open spotify.com/redeem while logged in, paste the code, done.',
    createdDays: -48,
  },
  {
    id: 'lst_canva',
    product: 'canva-pro-12m',
    seller: 'elena' as UserKey,
    description:
      'Canva Pro added to your own login for 12 months: 100M+ premium assets, Brand Kit, Magic Resize and the background remover.',
    quantity: 3,
    priceUsd: '9.00',
    deliveryInfo:
      'Reply with the e-mail on your Canva account and I send a team invite. Accept it and Pro unlocks immediately.',
    createdDays: -30,
  },
  {
    id: 'lst_chatgpt',
    product: 'chatgpt-plus-1m',
    seller: 'marcus' as UserKey,
    description:
      'One month of ChatGPT Plus applied to your own OpenAI account. Priority access at peak hours, faster responses, all the latest models.',
    quantity: 6,
    priceUsd: '14.00',
    deliveryInfo:
      'Send the e-mail on your OpenAI account. The upgrade is applied within the hour and I send you a confirmation screenshot.',
    createdDays: -27,
  },
  {
    id: 'lst_netflix',
    product: 'netflix-premium-3m',
    seller: 'marcus' as UserKey,
    description:
      'Your own profile on a Premium 4K household for three months. Ultra HD, four streams, downloads enabled. The profile PIN is yours alone.',
    quantity: 4,
    priceUsd: '32.00',
    deliveryInfo:
      'Login: demo-netflix@example.com / Pw: DemoPass-2026 — use the profile named after your order id and set your own PIN on first login.',
    createdDays: -21,
  },
  {
    id: 'lst_nordvpn',
    product: 'nordvpn-24m',
    seller: 'marcus' as UserKey,
    description:
      'Brand-new NordVPN account with 24 months prepaid. Six devices, Threat Protection, dedicated support. The credentials are yours to change on day one.',
    quantity: 1,
    priceUsd: '54.00',
    deliveryInfo:
      'Account: demo-nord@example.com / Pw: NordDemo-2026 — change the password right after your first login.',
    createdDays: -18,
  },
  {
    id: 'lst_notion',
    product: 'notion-plus-12m',
    seller: 'priya' as UserKey,
    description:
      'Notion Plus applied to your existing personal workspace for 12 months: unlimited blocks, 30-day version history, 100 guests.',
    quantity: 3,
    priceUsd: '44.00',
    deliveryInfo:
      'Send your workspace URL and the admin e-mail. Plus is applied to that workspace within a few hours.',
    createdDays: -11,
  },
  {
    id: 'lst_adobe',
    product: 'adobe-cc-photography-3m',
    seller: 'priya' as UserKey,
    description:
      'Lightroom + Photoshop with 20 GB of cloud storage, three months prepaid on your own Adobe ID. Desktop and mobile both included.',
    quantity: 5,
    priceUsd: '28.50',
    deliveryInfo:
      'Send your Adobe ID e-mail. The plan is attached to that ID and you keep every file you already have in the cloud.',
    createdDays: -6,
  },
];

// --------------------------------------------------------------------------- orders

/** The bucket each order is expected to land in — used only for the printed summary. */
type Bucket =
  'available' | 'vesting' | 'disputed' | 'withdrawing' | 'withdrawn' | 'none';

interface OrderSpec {
  id: string;
  listingId: string;
  buyer: UserKey;
  seller: UserKey;
  status: OrderStatus;
  /** days offset; undefined = never paid */
  paidDays?: number;
  vestDays?: number;
  /** defaults to the seller; only a won dispute moves it to the buyer */
  beneficiary?: UserKey;
  withdrawalId?: string;
  bucket: Bucket;
  note: string;
}

const ORDERS: OrderSpec[] = [
  {
    id: 'ord_pending_1',
    listingId: 'lst_netflix',
    buyer: 'tom',
    seller: 'marcus',
    status: OrderStatus.PENDING_PAYMENT,
    bucket: 'none',
    note: 'invoice open, awaiting payment',
  },
  {
    id: 'ord_pending_2',
    listingId: 'lst_notion',
    buyer: 'tom',
    seller: 'priya',
    status: OrderStatus.PENDING_PAYMENT,
    bucket: 'none',
    note: 'invoice open, awaiting payment',
  },
  {
    id: 'ord_vesting_1',
    listingId: 'lst_youtube',
    buyer: 'tom',
    seller: 'elena',
    status: OrderStatus.PAID,
    paidDays: -2,
    vestDays: 28,
    bucket: 'vesting',
    note: 'paid 2 days ago, 28 days of vesting left',
  },
  {
    id: 'ord_vesting_2',
    listingId: 'lst_canva',
    buyer: 'priya',
    seller: 'elena',
    status: OrderStatus.PAID,
    paidDays: -12,
    vestDays: 18,
    bucket: 'vesting',
    note: 'paid 12 days ago, 18 days of vesting left',
  },
  {
    id: 'ord_vesting_3',
    listingId: 'lst_chatgpt',
    buyer: 'tom',
    seller: 'marcus',
    status: OrderStatus.PAID,
    paidDays: -5,
    vestDays: 25,
    bucket: 'vesting',
    note: 'paid 5 days ago, 25 days of vesting left',
  },
  {
    id: 'ord_available_1',
    listingId: 'lst_spotify',
    buyer: 'tom',
    seller: 'elena',
    status: OrderStatus.PAID,
    paidDays: -45,
    vestDays: -15,
    bucket: 'available',
    note: 'vested 15 days ago — withdrawable now',
  },
  {
    id: 'ord_available_2',
    listingId: 'lst_nordvpn',
    buyer: 'priya',
    seller: 'marcus',
    status: OrderStatus.PAID,
    paidDays: -38,
    vestDays: -8,
    bucket: 'available',
    note: 'vested 8 days ago — withdrawable now',
  },
  {
    id: 'ord_disputed_1',
    listingId: 'lst_spotify',
    buyer: 'priya',
    seller: 'elena',
    status: OrderStatus.DISPUTED,
    paidDays: -6,
    vestDays: 24,
    bucket: 'disputed',
    note: 'OPEN dispute — frozen even once vesting passes',
  },
  {
    id: 'ord_refunded_1',
    listingId: 'lst_netflix',
    buyer: 'elena',
    seller: 'marcus',
    status: OrderStatus.REFUNDED,
    paidDays: -20,
    vestDays: -1,
    beneficiary: 'elena',
    bucket: 'available',
    note: 'buyer won the dispute — withdrawable by the BUYER',
  },
  {
    id: 'ord_withdrawn_1',
    listingId: 'lst_youtube',
    buyer: 'priya',
    seller: 'elena',
    status: OrderStatus.PAID,
    paidDays: -60,
    vestDays: -30,
    withdrawalId: 'wd_completed_1',
    bucket: 'withdrawn',
    note: 'already paid out via withdrawal wd_completed_1',
  },
];

// ----------------------------------------------------------------------------- main

/**
 * Units already claimed on a listing. Mirrors the runtime rule: every order that
 * is not EXPIRED holds one unit, an expired invoice gives its unit back.
 */
const soldOf = (listingId: string) =>
  ORDERS.filter(
    (o) => o.listingId === listingId && o.status !== OrderStatus.EXPIRED,
  ).length;

async function wipe() {
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.ALLOW_PROD_SEED !== 'true'
  ) {
    throw new Error(
      'Refusing to wipe a production database. Set ALLOW_PROD_SEED=true to override.',
    );
  }
  // FK-safe order: children first.
  await prisma.webhookEvent.deleteMany();
  await prisma.dispute.deleteMany();
  await prisma.order.deleteMany();
  await prisma.withdrawal.deleteMany();
  await prisma.listing.deleteMany();
  await prisma.product.deleteMany();
  await prisma.user.deleteMany();
}

async function main() {
  await wipe();

  // --- products ------------------------------------------------------------------
  // Same upsert-by-slug the app runs on boot; after wipe() these are plain creates.
  const products = new Map<
    string,
    {
      id: string;
      name: string;
      category: string;
      imageUrl: string | null;
      retail: Prisma.Decimal;
    }
  >();
  for (const p of CATALOG) {
    const created = await prisma.product.upsert({
      where: { slug: p.slug },
      create: {
        slug: p.slug,
        name: p.name,
        category: p.category,
        retailPriceUsd: new Prisma.Decimal(p.retailPriceUsd),
        imageUrl: p.imageUrl ?? null,
      },
      update: {},
    });
    products.set(p.slug, {
      id: created.id,
      name: created.name,
      category: created.category,
      imageUrl: created.imageUrl,
      retail: created.retailPriceUsd,
    });
  }

  // --- users -------------------------------------------------------------------
  const userIds = {} as Record<UserKey, string>;
  for (const [key, u] of Object.entries(USERS) as [
    UserKey,
    (typeof USERS)[UserKey],
  ][]) {
    const created = await prisma.user.create({
      data: {
        clerkUserId: `dev_${u.email}`,
        email: u.email,
        username: u.username,
        telegramUsername: u.telegramUsername,
        imageUrl: `https://i.pravatar.cc/160?u=${encodeURIComponent(u.email)}`,
        role: u.role,
        createdAt: days(-70),
      },
    });
    userIds[key] = created.id;
  }

  // --- listings ----------------------------------------------------------------
  for (const l of LISTINGS) {
    const product = products.get(l.product)!;
    await prisma.listing.create({
      data: {
        id: l.id,
        sellerId: userIds[l.seller],
        productId: product.id,
        // copied from the product, exactly like POST /api/listings does
        title: product.name,
        category: product.category,
        imageUrl: product.imageUrl,
        description: l.description,
        priceUsd: new Prisma.Decimal(l.priceUsd),
        deliveryInfo: l.deliveryInfo,
        quantity: l.quantity,
        soldCount: soldOf(l.id),
        // A listing whose units are all claimed is off the marketplace.
        status:
          soldOf(l.id) >= l.quantity
            ? ListingStatus.SOLD_OUT
            : ListingStatus.ACTIVE,
        createdAt: days(l.createdDays),
        updatedAt: days(l.createdDays),
      },
    });
  }
  const listingOf = new Map(LISTINGS.map((l) => [l.id, l]));
  const productOf = (listingId: string) =>
    products.get(listingOf.get(listingId)!.product)!;

  // --- withdrawal (created before the order that links to it) -------------------
  const withdrawnOrder = ORDERS.find((o) => o.id === 'ord_withdrawn_1')!;
  const withdrawnAmount = calcFee(
    listingOf.get(withdrawnOrder.listingId)!.priceUsd,
    FEE_PERCENT,
  ).sellerAmountUsd;

  await prisma.withdrawal.create({
    data: {
      id: 'wd_completed_1',
      userId: userIds.elena,
      amountUsd: withdrawnAmount,
      currency: 'USDT',
      network: 'TRC20',
      address: 'TQn9Y2khDD95J42FQtQTdwVVR93DemoAddr',
      status: WithdrawalStatus.COMPLETED,
      oxapayTrackId: 'seed_payout_completed_1',
      completedAt: days(-29),
      createdAt: days(-29),
      updatedAt: days(-29),
    },
  });

  // --- orders ------------------------------------------------------------------
  const sellerAmounts = new Map<string, Prisma.Decimal>();
  const buyerAmounts = new Map<string, Prisma.Decimal>();
  for (const o of ORDERS) {
    const product = productOf(o.listingId);
    const { amountUsd, feeUsd, sellerAmountUsd } = calcFee(
      listingOf.get(o.listingId)!.priceUsd,
      FEE_PERCENT,
    );
    sellerAmounts.set(o.id, sellerAmountUsd);
    buyerAmounts.set(o.id, amountUsd);

    const createdAt = days(o.paidDays ?? -1);

    await prisma.order.create({
      data: {
        id: o.id,
        listingId: o.listingId,
        buyerId: userIds[o.buyer],
        sellerId: userIds[o.seller],
        titleSnapshot: product.name,
        // retail price frozen at "purchase" time — feeds GET /api/stats/savings
        productId: product.id,
        retailPriceUsdSnapshot: product.retail,
        amountUsd,
        feeUsd,
        sellerAmountUsd,
        status: o.status,
        beneficiaryId: userIds[o.beneficiary ?? o.seller],
        oxapayTrackId: `seed_track_${o.id}`,
        paymentUrl: `${PUBLIC_API_URL}/api/dev/mock-pay/${o.id}`,
        paidAt: o.paidDays !== undefined ? days(o.paidDays) : null,
        vestedAt: o.vestDays !== undefined ? days(o.vestDays) : null,
        withdrawalId: o.withdrawalId ?? null,
        createdAt,
        updatedAt: createdAt,
      },
    });
  }

  // --- disputes ----------------------------------------------------------------
  await prisma.dispute.create({
    data: {
      id: 'dsp_open_1',
      orderId: 'ord_disputed_1',
      openedById: userIds.priya,
      reason:
        'The redeem code was already used when I tried it. Spotify says the account is not eligible and the seller has not replied for two days.',
      status: DisputeStatus.OPEN,
      // Telegram fields stay null on purpose: the group is created live during the
      // demo via POST /api/admin/disputes/dsp_open_1/telegram-retry.
      createdAt: days(-4),
      updatedAt: days(-4),
    },
  });

  await prisma.dispute.create({
    data: {
      id: 'dsp_resolved_buyer_1',
      orderId: 'ord_refunded_1',
      openedById: userIds.elena,
      reason:
        'The Netflix profile was removed from the household after nine days. The seller stopped answering.',
      status: DisputeStatus.RESOLVED_BUYER,
      resolvedById: userIds.admin,
      resolutionNote:
        'Seller could not show the profile was still active. Refund goes to the buyer, withdrawable immediately.',
      resolvedAt: days(-1),
      createdAt: days(-3),
      updatedAt: days(-1),
    },
  });

  printSummary(sellerAmounts, buyerAmounts, productOf);
}

// -------------------------------------------------------------------------- summary

function printSummary(
  sellerAmounts: Map<string, Prisma.Decimal>,
  buyerAmounts: Map<string, Prisma.Decimal>,
  productOf: (listingId: string) => { retail: Prisma.Decimal },
) {
  const keys: UserKey[] = ['admin', 'elena', 'marcus', 'priya', 'tom'];
  const buckets: Bucket[] = [
    'available',
    'vesting',
    'disputed',
    'withdrawing',
    'withdrawn',
  ];

  // Beneficiary, not seller: a won dispute moves the money to the buyer.
  const amountsIn = (user: UserKey, bucket: Bucket) =>
    ORDERS.filter(
      (o) => (o.beneficiary ?? o.seller) === user && o.bucket === bucket,
    ).map((o) => sellerAmounts.get(o.id)!);

  const headers = [
    'USER',
    'LOGIN AS (x-dev-user-email)',
    ...buckets.map((b) => b.toUpperCase()),
  ];
  const rows = keys.map((k) => [
    USERS[k].username,
    USERS[k].email,
    ...buckets.map((b) => toFixed2(sum(amountsIn(k, b)))),
  ]);

  const widths = headers.map((_, i) =>
    Math.max(...[headers, ...rows].map((r) => r[i].length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i < 2 ? c.padEnd(widths[i]) : c.padStart(widths[i])))
      .join('  ');
  const rule = '='.repeat(widths.reduce((a, b) => a + b + 2, 0));

  const out: string[] = [
    '',
    rule,
    ' SEED COMPLETE — demo dataset ready',
    rule,
    '',
  ];
  out.push(
    ` ${USERS.admin.username} <${USERS.admin.email}> is the ADMIN (from ADMIN_EMAILS).`,
  );
  out.push(
    ` ${CATALOG.length} catalog products · ${LISTINGS.length} active listings · ${ORDERS.length} orders · 2 disputes · 1 completed withdrawal`,
  );
  out.push('');
  out.push(
    ' BALANCE BUCKETS (USD) — these should match GET /api/wallet/balance exactly',
  );
  out.push('');
  out.push(' ' + line(headers));
  out.push(' ' + widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) out.push(' ' + line(r));
  out.push('');

  out.push(' ORDERS');
  const idW = Math.max(...ORDERS.map((o) => o.id.length));
  const stW = Math.max(...ORDERS.map((o) => o.status.length));
  for (const o of ORDERS) {
    const owner = USERS[o.beneficiary ?? o.seller].username;
    out.push(
      `   ${o.id.padEnd(idW)}  ${o.status.padEnd(stW)}  ` +
        `$${toFixed2(sellerAmounts.get(o.id)!).padStart(6)} → ${owner.padEnd(14)} ${o.note}`,
    );
  }
  out.push('');

  // Mirrors GET /api/stats/savings: PAID + DISPUTED orders only, retail snapshot
  // minus what the buyer paid. REFUNDED / PENDING / EXPIRED count for nothing.
  out.push(
    ' BUYER SAVINGS — GET /api/stats/savings should match these numbers',
  );
  const savingsStatuses: OrderStatus[] = [
    OrderStatus.PAID,
    OrderStatus.DISPUTED,
  ];
  for (const k of keys) {
    const bought = ORDERS.filter(
      (o) => o.buyer === k && savingsStatuses.includes(o.status),
    );
    if (!bought.length) continue;
    const spent = sum(bought.map((o) => buyerAmounts.get(o.id)!));
    const retail = sum(bought.map((o) => productOf(o.listingId).retail));
    const saved = retail.minus(spent);
    const pct = retail.isZero()
      ? '0.00'
      : saved.times(100).dividedBy(retail).toFixed(2);
    out.push(
      `   ${USERS[k].email.padEnd(28)} ${String(bought.length)} orders · ` +
        `spent $${toFixed2(spent)} · retail $${toFixed2(retail)} · ` +
        `saved $${toFixed2(saved)} (${pct}%)`,
    );
  }
  out.push('');

  out.push(' DEMO CHEAT SHEET');
  out.push(
    `   Money in every bucket (main demo account) .. ${USERS.elena.email}`,
  );
  out.push(
    `   One clean payout ready to withdraw ......... ${USERS.marcus.email}`,
  );
  out.push(
    `   Buyer with two unpaid invoices ............. ${USERS.tom.email}`,
  );
  out.push(
    `   Admin — dispute dsp_open_1 is OPEN ......... ${USERS.admin.email}`,
  );
  out.push('');
  out.push(
    '   Nothing sits in "withdrawing": that bucket fills the moment you call',
  );
  out.push('   POST /api/wallet/withdraw as Elena or Marcus during the demo.');
  out.push('');
  out.push(
    `   Pay an open invoice: ${PUBLIC_API_URL}/api/dev/mock-pay/ord_pending_1`,
  );
  out.push(
    `   Platform fee ${FEE_PERCENT}% · seeded vesting dates are fixed; VESTING_DAYS=` +
      `${process.env.VESTING_DAYS ?? '30'} only applies to orders paid from now on.`,
  );
  out.push('');

  console.log(out.join('\n'));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
