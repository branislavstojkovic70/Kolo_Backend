/**
 * DEMO SEED — the dataset used for the live walkthrough, built around the four
 * real accounts instead of the example.com cast in seed.ts.
 *
 *   npm run demo:seed
 *
 * Destructive but safe on the people: every listing, order, dispute, withdrawal
 * and webhook event is deleted and rewritten, while the four real users are
 * matched BY EMAIL and keep their clerkUserId, so nobody has to sign in again.
 * Leftover @example.com accounts from seed.ts are removed so the marketplace
 * shows real names only.
 *
 * Idempotent: fixed ids everywhere, so running it twice gives the same database.
 *
 * paidAt / vestedAt are written directly, exactly like seed.ts — the vesting
 * spread has to be visible today, nobody waits 30 days. VESTING_DAYS only
 * applies to orders paid live through the webhook during the demo.
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

/** The product catalog — same file ProductsService syncs on every boot. */
const CATALOG: {
  slug: string;
  name: string;
  category: string;
  retailPriceUsd: string;
  imageUrl?: string;
}[] = JSON.parse(readFileSync(join(__dirname, 'products.json'), 'utf8')) as {
  slug: string;
  name: string;
  category: string;
  retailPriceUsd: string;
  imageUrl?: string;
}[];

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.now();
/** days(-45) = 45 days ago, days(28) = 28 days from now */
const days = (n: number) => new Date(T0 + n * DAY);

const FEE_PERCENT = parseFloat(process.env.PLATFORM_FEE_PERCENT ?? '5');
const PUBLIC_API_URL = process.env.PUBLIC_API_URL ?? 'http://localhost:3000';

// ---------------------------------------------------------------------------- users

const USERS = {
  bane: {
    email: 'bangiekg@gmail.com',
    username: 'Branislav',
    telegramUsername: 'banes01',
    role: Role.USER,
  },
  stojkovic: {
    email: 'bstojkovic43@gmail.com',
    username: 'Branislav Stojkovic',
    telegramUsername: null,
    role: Role.USER,
  },
  uros: {
    email: 'uros.zigic@gmail.com',
    username: 'Uros Zigic',
    telegramUsername: null,
    role: Role.USER,
  },
  admin: {
    email: 'branislavanja001@gmail.com',
    username: 'Platform Admin',
    telegramUsername: 'banes01',
    role: Role.ADMIN,
  },
} as const;

type UserKey = keyof typeof USERS;

// ------------------------------------------------------------------------- listings

interface ListingSpec {
  id: string;
  seller: UserKey;
  /** catalog slug — title/category are copied from this product at create time */
  product: string;
  title: string;
  description: string;
  category: string;
  priceUsd: string;
  /** how many units the seller offers */
  quantity: number;
  deliveryInfo: string;
  imageUrl: string;
  createdDays: number;
}

const LISTINGS: ListingSpec[] = [
  {
    id: 'lst_youtube',
    product: 'youtube-premium-12m',
    seller: 'bane',
    title: 'YouTube Premium — 12 months on your own account',
    description:
      'Family-plan invite for the Google account you already use. Ad-free video, background play and YouTube Music for a full year. No password sharing, nothing to install, works worldwide.',
    category: 'Streaming',
    quantity: 5,
    priceUsd: '24.99',
    deliveryInfo:
      'Send me the Gmail address on your Google account. The family invite arrives within 30 minutes — accept it and Premium is live instantly.',
    imageUrl: 'https://picsum.photos/seed/kolo-youtube/800/500',
    createdDays: -64,
  },
  {
    id: 'lst_spotify',
    product: 'spotify-premium-6m',
    seller: 'bane',
    title: 'Spotify Premium Individual — 6 months',
    description:
      'Six prepaid months of Spotify Premium on your existing account. Your playlists, follows and listening history all stay exactly where they are.',
    category: 'Streaming',
    quantity: 4,
    priceUsd: '17.50',
    deliveryInfo:
      'Redeem code: SPOT-KOLO-6MON-4417. Open spotify.com/redeem while logged in, paste the code, done.',
    imageUrl: 'https://picsum.photos/seed/kolo-spotify/800/500',
    createdDays: -52,
  },
  {
    id: 'lst_chatgpt',
    product: 'chatgpt-plus-1m',
    seller: 'bane',
    title: 'ChatGPT Plus — 1 month on your account',
    description:
      'One month of ChatGPT Plus applied to your own OpenAI account. Priority access at peak hours, faster responses, all the latest models.',
    category: 'AI Tools',
    quantity: 6,
    priceUsd: '14.00',
    deliveryInfo:
      'Send the e-mail on your OpenAI account. The upgrade is applied within the hour and I send you a confirmation screenshot.',
    imageUrl: 'https://picsum.photos/seed/kolo-chatgpt/800/500',
    createdDays: -44,
  },
  {
    id: 'lst_nordvpn',
    product: 'nordvpn-24m',
    seller: 'bane',
    title: 'NordVPN — 2 year plan, fresh account',
    description:
      'Brand-new NordVPN account with 24 months prepaid. Six devices, Threat Protection, dedicated support. The credentials are yours to change on day one.',
    category: 'Privacy & Security',
    quantity: 1,
    priceUsd: '54.00',
    deliveryInfo:
      'Account: kolo-nord-4417@proton.me / Pw: NordKolo-2026 — change the password right after your first login.',
    imageUrl: 'https://picsum.photos/seed/kolo-nordvpn/800/500',
    createdDays: -33,
  },
  {
    id: 'lst_canva',
    product: 'canva-pro-12m',
    seller: 'bane',
    title: 'Canva Pro — 1 year, your own account',
    description:
      'Canva Pro added to your own login for 12 months: 100M+ premium assets, Brand Kit, Magic Resize and the background remover.',
    category: 'Design',
    quantity: 3,
    priceUsd: '9.00',
    deliveryInfo:
      'Reply with the e-mail on your Canva account and I send a team invite. Accept it and Pro unlocks immediately.',
    imageUrl: 'https://picsum.photos/seed/kolo-canva/800/500',
    createdDays: -25,
  },
  {
    id: 'lst_netflix',
    product: 'netflix-premium-3m',
    seller: 'stojkovic',
    title: 'Netflix Premium 4K — 3 months (private profile)',
    description:
      'Your own profile on a Premium 4K household for three months. Ultra HD, four streams, downloads enabled. The profile PIN is yours alone.',
    category: 'Streaming',
    quantity: 4,
    priceUsd: '32.00',
    deliveryInfo:
      'Login: kolo-netflix@proton.me / Pw: KoloPass-2026 — use the profile named after your order id and set your own PIN on first login.',
    imageUrl: 'https://picsum.photos/seed/kolo-netflix/800/500',
    createdDays: -39,
  },
  {
    id: 'lst_notion',
    product: 'notion-plus-12m',
    seller: 'stojkovic',
    title: 'Notion Plus — 1 year for your workspace',
    description:
      'Notion Plus applied to your existing personal workspace for 12 months: unlimited blocks, 30-day version history, 100 guests.',
    category: 'Productivity',
    quantity: 3,
    priceUsd: '44.00',
    deliveryInfo:
      'Send your workspace URL and the admin e-mail. Plus is applied to that workspace within a few hours.',
    imageUrl: 'https://picsum.photos/seed/kolo-notion/800/500',
    createdDays: -28,
  },
  {
    id: 'lst_adobe',
    product: 'adobe-cc-photography-3m',
    seller: 'stojkovic',
    title: 'Adobe Creative Cloud Photography — 3 months',
    description:
      'Lightroom + Photoshop with 20 GB of cloud storage, three months prepaid on your own Adobe ID. Desktop and mobile both included.',
    category: 'Design',
    quantity: 5,
    priceUsd: '28.50',
    deliveryInfo:
      'Send your Adobe ID e-mail. The plan is attached to that ID and you keep every file you already have in the cloud.',
    imageUrl: 'https://picsum.photos/seed/kolo-adobe/800/500',
    createdDays: -19,
  },
  {
    id: 'lst_office',
    product: 'microsoft-365-personal-12m',
    seller: 'uros',
    title: 'Microsoft 365 Family — 12 months, your own seat',
    description:
      'A seat on a Microsoft 365 Family subscription for a year: Word, Excel, PowerPoint and Outlook on every device, plus 1 TB of OneDrive storage.',
    category: 'Productivity',
    quantity: 2,
    priceUsd: '39.00',
    deliveryInfo:
      'Send the e-mail on your Microsoft account and I add it to the family. Accept the invite and the 1 TB shows up in OneDrive right away.',
    imageUrl: 'https://picsum.photos/seed/kolo-office/800/500',
    createdDays: -13,
  },
];

// --------------------------------------------------------------------------- orders

/** The wallet bucket the order is expected to land in — used for the printed summary. */
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
  // --- open invoices: the live "pay it on stage" moment -----------------------
  {
    id: 'ord_open_1',
    listingId: 'lst_youtube',
    buyer: 'uros',
    seller: 'bane',
    status: OrderStatus.PENDING_PAYMENT,
    bucket: 'none',
    note: 'invoice open — pay this one live during the demo',
  },
  {
    id: 'ord_open_2',
    listingId: 'lst_office',
    buyer: 'stojkovic',
    seller: 'uros',
    status: OrderStatus.PENDING_PAYMENT,
    bucket: 'none',
    note: 'invoice open, awaiting payment',
  },
  {
    id: 'ord_expired_1',
    listingId: 'lst_canva',
    buyer: 'uros',
    seller: 'bane',
    status: OrderStatus.EXPIRED,
    bucket: 'none',
    note: 'invoice lapsed before it was paid',
  },

  // --- money still vesting ----------------------------------------------------
  {
    id: 'ord_vesting_1',
    listingId: 'lst_chatgpt',
    buyer: 'uros',
    seller: 'bane',
    status: OrderStatus.PAID,
    paidDays: -2,
    vestDays: 28,
    bucket: 'vesting',
    note: 'paid 2 days ago, 28 days of vesting left',
  },
  {
    id: 'ord_vesting_2',
    listingId: 'lst_spotify',
    buyer: 'stojkovic',
    seller: 'bane',
    status: OrderStatus.PAID,
    paidDays: -9,
    vestDays: 21,
    bucket: 'vesting',
    note: 'paid 9 days ago, 21 days of vesting left',
  },
  {
    id: 'ord_vesting_3',
    listingId: 'lst_notion',
    buyer: 'uros',
    seller: 'stojkovic',
    status: OrderStatus.PAID,
    paidDays: -6,
    vestDays: 24,
    bucket: 'vesting',
    note: 'paid 6 days ago, 24 days of vesting left',
  },
  {
    id: 'ord_vesting_4',
    listingId: 'lst_adobe',
    buyer: 'bane',
    seller: 'stojkovic',
    status: OrderStatus.PAID,
    paidDays: -20,
    vestDays: 10,
    bucket: 'vesting',
    note: 'a purchase of yours — delivery details are unlocked on the order page',
  },

  // --- vested, ready to withdraw ---------------------------------------------
  {
    id: 'ord_available_1',
    listingId: 'lst_nordvpn',
    buyer: 'stojkovic',
    seller: 'bane',
    status: OrderStatus.PAID,
    paidDays: -41,
    vestDays: -11,
    bucket: 'available',
    note: 'vested 11 days ago',
  },
  {
    id: 'ord_available_2',
    listingId: 'lst_spotify',
    buyer: 'uros',
    seller: 'bane',
    status: OrderStatus.PAID,
    paidDays: -37,
    vestDays: -7,
    bucket: 'available',
    note: 'vested 7 days ago',
  },
  {
    id: 'ord_available_3',
    listingId: 'lst_adobe',
    buyer: 'uros',
    seller: 'stojkovic',
    status: OrderStatus.PAID,
    paidDays: -35,
    vestDays: -5,
    bucket: 'available',
    note: 'vested 5 days ago',
  },

  // --- disputes ---------------------------------------------------------------
  {
    id: 'ord_disputed_1',
    listingId: 'lst_youtube',
    buyer: 'uros',
    seller: 'bane',
    status: OrderStatus.DISPUTED,
    paidDays: -12,
    vestDays: 18,
    bucket: 'disputed',
    note: 'OPEN dispute — frozen even once it vests',
  },
  {
    id: 'ord_refunded_1',
    listingId: 'lst_netflix',
    buyer: 'bane',
    seller: 'stojkovic',
    status: OrderStatus.REFUNDED,
    paidDays: -47,
    vestDays: -17,
    beneficiary: 'bane',
    bucket: 'available',
    note: 'you won this dispute — refund is withdrawable immediately',
  },
  {
    id: 'ord_dispute_won_1',
    listingId: 'lst_chatgpt',
    buyer: 'stojkovic',
    seller: 'bane',
    status: OrderStatus.PAID,
    paidDays: -33,
    vestDays: -3,
    bucket: 'available',
    note: 'dispute resolved for you as the seller — original vesting clock kept',
  },

  // --- already paid out -------------------------------------------------------
  {
    id: 'ord_withdrawn_1',
    listingId: 'lst_youtube',
    buyer: 'stojkovic',
    seller: 'bane',
    status: OrderStatus.PAID,
    paidDays: -70,
    vestDays: -40,
    withdrawalId: 'wd_completed_1',
    bucket: 'withdrawn',
    note: 'bundled into the completed payout',
  },
];

/**
 * Units already claimed on a listing. Mirrors the runtime rule: every order that
 * is not EXPIRED holds one unit, an expired invoice gives its unit back.
 */
/** soldCount is SETTLED units only — unpaid orders hold theirs via a reservation. */
const SETTLED: OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.DISPUTED,
  OrderStatus.REFUNDED,
];

const soldOf = (listingId: string) =>
  ORDERS.filter(
    (o) => o.listingId === listingId && SETTLED.includes(o.status),
  ).length;

const heldOrdersOf = (listingId: string) =>
  ORDERS.filter(
    (o) =>
      o.listingId === listingId && o.status === OrderStatus.PENDING_PAYMENT,
  );

// -------------------------------------------------------------------------- wipe

/** Order matters: children before parents, and Order points at Withdrawal. */
async function wipe() {
  await prisma.webhookEvent.deleteMany();
  await prisma.buyRequest.deleteMany();
  await prisma.listingReservation.deleteMany();
  await prisma.dispute.deleteMany();
  await prisma.order.deleteMany();
  await prisma.withdrawal.deleteMany();
  await prisma.listing.deleteMany();
  // Only the seed.ts cast — the four real accounts are kept and updated in place.
  await prisma.user.deleteMany({
    where: { email: { endsWith: '@example.com' } },
  });
}

// -------------------------------------------------------------------------- main

async function main() {
  await wipe();

  // --- products: same upsert-by-slug the app runs on boot -----------------------
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
    const data = {
      name: p.name,
      category: p.category,
      retailPriceUsd: new Prisma.Decimal(p.retailPriceUsd),
      imageUrl: p.imageUrl ?? null,
      active: true,
    };
    const created = await prisma.product.upsert({
      where: { slug: p.slug },
      create: { slug: p.slug, ...data },
      update: data,
    });
    products.set(p.slug, {
      id: created.id,
      name: created.name,
      category: created.category,
      imageUrl: created.imageUrl,
      retail: created.retailPriceUsd,
    });
  }

  // --- users: match on e-mail so a real clerkUserId is never overwritten -------
  const userIds = {} as Record<UserKey, string>;
  for (const [key, u] of Object.entries(USERS) as [
    UserKey,
    (typeof USERS)[UserKey],
  ][]) {
    const existing = await prisma.user.findUnique({
      where: { email: u.email },
    });

    const person = existing
      ? await prisma.user.update({
          where: { id: existing.id },
          data: {
            username: u.username,
            telegramUsername: u.telegramUsername,
            role: u.role,
          },
        })
      : await prisma.user.create({
          data: {
            // Matches what DEV_AUTH_BYPASS generates, and ClerkAuthGuard adopts
            // the row by e-mail on the first real sign-in anyway.
            clerkUserId: `dev_${u.email}`,
            email: u.email,
            username: u.username,
            telegramUsername: u.telegramUsername,
            imageUrl: `https://i.pravatar.cc/160?u=${encodeURIComponent(u.email)}`,
            role: u.role,
            createdAt: days(-75),
          },
        });

    userIds[key] = person.id;
  }

  // --- listings ---------------------------------------------------------------
  for (const l of LISTINGS) {
    const product = products.get(l.product)!;
    await prisma.listing.create({
      data: {
        id: l.id,
        sellerId: userIds[l.seller],
        // title/category are copied from the catalog product, like POST /api/listings
        productId: product.id,
        title: product.name,
        category: product.category,
        description: l.description,
        imageUrl: l.imageUrl,
        priceUsd: new Prisma.Decimal(l.priceUsd),
        deliveryInfo: l.deliveryInfo,
        quantity: l.quantity,
        soldCount: soldOf(l.id),
        // soldCount is settled units only; a listing leaves the marketplace only
        // once every unit is paid for.
        status:
          soldOf(l.id) >= l.quantity
            ? ListingStatus.SOLD
            : ListingStatus.ACTIVE,
        createdAt: days(l.createdDays),
        updatedAt: days(l.createdDays),
      },
    });
  }
  const priceOf = new Map(LISTINGS.map((l) => [l.id, l.priceUsd]));
  const productOf = new Map(
    LISTINGS.map((l) => [l.id, products.get(l.product)!]),
  );
  const titleOf = new Map(
    LISTINGS.map((l) => [l.id, products.get(l.product)!.name]),
  );

  // --- withdrawal, created before the order that links to it ------------------
  const withdrawn = ORDERS.find((o) => o.id === 'ord_withdrawn_1')!;
  const withdrawnAmount = calcFee(
    priceOf.get(withdrawn.listingId)!,
    FEE_PERCENT,
  ).sellerAmountUsd;

  await prisma.withdrawal.create({
    data: {
      id: 'wd_completed_1',
      userId: userIds.bane,
      amountUsd: withdrawnAmount,
      currency: 'USDT',
      network: 'TRC20',
      address: 'TQn9Y2khDD95J42FQtQTdwVVR93KoloDemo',
      status: WithdrawalStatus.COMPLETED,
      oxapayTrackId: 'demo_payout_completed_1',
      completedAt: days(-38),
      createdAt: days(-39),
      updatedAt: days(-38),
    },
  });

  // --- orders -----------------------------------------------------------------
  const sellerAmounts = new Map<string, Prisma.Decimal>();
  for (const o of ORDERS) {
    const { amountUsd, feeUsd, sellerAmountUsd } = calcFee(
      priceOf.get(o.listingId)!,
      FEE_PERCENT,
    );
    sellerAmounts.set(o.id, sellerAmountUsd);

    const createdAt = days(o.paidDays ?? -1);

    await prisma.order.create({
      data: {
        id: o.id,
        listingId: o.listingId,
        buyerId: userIds[o.buyer],
        sellerId: userIds[o.seller],
        titleSnapshot: titleOf.get(o.listingId)!,
        // retail price frozen at "purchase" time — feeds GET /api/stats/savings
        productId: productOf.get(o.listingId)!.id,
        retailPriceUsdSnapshot: productOf.get(o.listingId)!.retail,
        amountUsd,
        feeUsd,
        sellerAmountUsd,
        status: o.status,
        beneficiaryId: userIds[o.beneficiary ?? o.seller],
        oxapayTrackId: `demo_track_${o.id}`,
        paymentUrl: `${PUBLIC_API_URL}/api/dev/mock-pay/${o.id}`,
        paidAt: o.paidDays !== undefined ? days(o.paidDays) : null,
        vestedAt: o.vestDays !== undefined ? days(o.vestDays) : null,
        withdrawalId: o.withdrawalId ?? null,
        createdAt,
        updatedAt: createdAt,
      },
    });
  }

  // --- reservations ------------------------------------------------------------
  // Each unpaid order holds one unit, so it cannot be oversold while it waits.
  const RESERVATION_MINUTES = parseInt(
    process.env.AUTO_BUY_RESERVATION_MINUTES ?? '15',
    10,
  );
  for (const l of LISTINGS) {
    for (const o of heldOrdersOf(l.id)) {
      await prisma.listingReservation.create({
        data: {
          id: `lrsv_${o.id}`,
          listingId: l.id,
          buyerId: userIds[o.buyer],
          orderId: o.id,
          quantity: 1,
          expiresAt: new Date(T0 + RESERVATION_MINUTES * 60_000),
        },
      });
    }
  }

  // --- disputes ---------------------------------------------------------------

  // Telegram fields stay null on purpose: the group is created live on stage with
  // POST /api/admin/disputes/dsp_open_1/telegram-retry.
  await prisma.dispute.create({
    data: {
      id: 'dsp_open_1',
      orderId: 'ord_disputed_1',
      openedById: userIds.uros,
      reason:
        'The family invite never arrived. I sent my Gmail address twice on the day of purchase and again three days later, and the seller has not answered since. Premium is still not active on my account.',
      status: DisputeStatus.OPEN,
      createdAt: days(-5),
      updatedAt: days(-5),
    },
  });

  await prisma.dispute.create({
    data: {
      id: 'dsp_resolved_buyer_1',
      orderId: 'ord_refunded_1',
      openedById: userIds.bane,
      reason:
        'The Netflix profile was removed from the household after nine days, well inside the three months I paid for. The seller stopped replying once I asked for it back.',
      status: DisputeStatus.RESOLVED_BUYER,
      resolvedById: userIds.admin,
      resolutionNote:
        'The seller could not show the profile was still active and did not respond within the review window. Refunded to the buyer, withdrawable immediately.',
      resolvedAt: days(-30),
      createdAt: days(-34),
      updatedAt: days(-30),
    },
  });

  await prisma.dispute.create({
    data: {
      id: 'dsp_resolved_seller_1',
      orderId: 'ord_dispute_won_1',
      openedById: userIds.stojkovic,
      reason:
        'ChatGPT Plus was not showing on my account the evening I paid, so I opened a dispute the same night.',
      status: DisputeStatus.RESOLVED_SELLER,
      resolvedById: userIds.admin,
      resolutionNote:
        'The seller provided a timestamped confirmation from OpenAI showing the upgrade was applied within the hour, and the buyer confirmed Plus is active. Funds stay with the seller on the original vesting date.',
      resolvedAt: days(-28),
      createdAt: days(-31),
      updatedAt: days(-28),
    },
  });

  printSummary(sellerAmounts);
}

// -------------------------------------------------------------------------- summary

function printSummary(sellerAmounts: Map<string, Prisma.Decimal>) {
  const keys: UserKey[] = ['bane', 'stojkovic', 'uros', 'admin'];
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

  const headers = ['USER', 'E-MAIL', ...buckets.map((b) => b.toUpperCase())];
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
    ' DEMO DATA READY',
    rule,
    '',
    ` ${LISTINGS.length} listings · ${ORDERS.length} orders · 3 disputes · 1 completed payout · platform fee ${FEE_PERCENT}%`,
    '',
    ' WALLET BUCKETS (USD) — these match GET /api/wallet/balance exactly',
    '',
    ' ' + line(headers),
    ' ' + widths.map((w) => '-'.repeat(w)).join('  '),
    ...rows.map((r) => ' ' + line(r)),
    '',
    ' ORDERS',
  ];

  const idW = Math.max(...ORDERS.map((o) => o.id.length));
  const stW = Math.max(...ORDERS.map((o) => o.status.length));
  for (const o of ORDERS) {
    const owner = USERS[o.beneficiary ?? o.seller].username;
    out.push(
      `   ${o.id.padEnd(idW)}  ${o.status.padEnd(stW)}  ` +
        `$${toFixed2(sellerAmounts.get(o.id)!).padStart(6)} -> ${owner.padEnd(19)} ${o.note}`,
    );
  }

  out.push('');
  out.push(' DEMO RUNBOOK');
  out.push(
    `   1. Sign in as ${USERS.bane.email} — wallet has money in every bucket.`,
  );
  out.push(
    '   2. Wallet: press Withdraw. The available bucket empties into "withdrawing"',
  );
  out.push('      and a payout row appears.');
  out.push(
    '   3. Marketplace: buy anything as another account, then pay the invoice at',
  );
  out.push(`      ${PUBLIC_API_URL}/api/dev/mock-pay/<orderId>`);
  out.push(
    `      (or open ${PUBLIC_API_URL}/api/dev/mock-pay/ord_open_1 for the invoice that is already waiting).`,
  );
  out.push(
    `   4. Sign in as ${USERS.admin.email} — Arbitration lists all three disputes.`,
  );
  out.push(
    '      dsp_open_1 is the OPEN one; resolve it either way live on stage.',
  );
  out.push(
    '   5. Telegram group for that dispute (creates a real group + invite link):',
  );
  out.push(
    `      curl -X POST "${PUBLIC_API_URL}/api/admin/disputes/dsp_open_1/telegram-retry" \\`,
  );
  out.push(`           -H "x-dev-user-email: ${USERS.admin.email}"`);
  out.push('');
  out.push(
    `   Nothing sits in "withdrawing" — that bucket fills the moment you press Withdraw.`,
  );
  out.push(
    `   Vesting dates are fixed here; VESTING_DAYS=${process.env.VESTING_DAYS ?? '30'} only applies to orders paid from now on.`,
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
