/**
 * Response examples for /docs. These are the literal JSON shapes the API returns —
 * the FE team can code against them before a single endpoint is called.
 *
 * Two conventions hold everywhere and are visible in every example below:
 *   - every money field is a STRING with exactly 2 decimals ("24.99"), never a float
 *   - every timestamp is ISO-8601 UTC ("2026-08-30T09:12:44.000Z"), or null
 */

const USER_STUB = {
  id: 'cmf3k1a2b0000q1x8n7d5e9f1',
  username: 'Elena Petrova',
  imageUrl: 'https://i.pravatar.cc/160?u=elena.petrova%40example.com',
};

const USER_STUB_EMAIL = {
  id: 'cmf3k1a2b0000q1x8n7d5e9f1',
  email: 'elena.petrova@example.com',
  username: 'Elena Petrova',
};

export const ME = {
  id: 'cmf3k1a2b0000q1x8n7d5e9f1',
  email: 'elena.petrova@example.com',
  username: 'Elena Petrova',
  imageUrl: 'https://i.pravatar.cc/160?u=elena.petrova%40example.com',
  telegramUsername: 'elena_digital',
  role: 'USER',
  createdAt: '2026-06-21T09:00:00.000Z',
};

export const LISTING = {
  id: 'lst_youtube',
  sellerId: USER_STUB.id,
  title: 'YouTube Premium — 12 months on your own account',
  description: 'Family-plan invite for the Google account you already use…',
  category: 'Streaming',
  priceUsd: '24.99',
  status: 'ACTIVE',
  createdAt: '2026-06-29T09:00:00.000Z',
  updatedAt: '2026-06-29T09:00:00.000Z',
  seller: USER_STUB,
};

export const LISTING_PAGE = {
  items: [LISTING],
  total: 8,
  page: 1,
  limit: 20,
  pages: 1,
};

export const LISTING_DELETED = { id: 'lst_youtube', status: 'DELETED' };

export const ORDER = {
  id: 'ord_vesting_1',
  listingId: 'lst_youtube',
  buyerId: 'cmf3k1a2b0004q1x8p2c7h1k9',
  sellerId: USER_STUB.id,
  titleSnapshot: 'YouTube Premium — 12 months on your own account',
  amountUsd: '24.99',
  feeUsd: '1.25',
  sellerAmountUsd: '23.74',
  status: 'PAID',
  beneficiaryId: USER_STUB.id,
  oxapayTrackId: 'seed_track_ord_vesting_1',
  paymentUrl: 'https://pay.oxapay.com/1234567',
  paidAt: '2026-08-28T09:12:44.000Z',
  vestedAt: '2026-09-27T09:12:44.000Z',
  withdrawalId: null,
  createdAt: '2026-08-28T09:10:02.000Z',
  updatedAt: '2026-08-28T09:12:44.000Z',
  buyer: {
    id: 'cmf3k1a2b0004q1x8p2c7h1k9',
    username: 'Tom Becker',
    imageUrl: null,
  },
  seller: USER_STUB,
};

export const ORDER_CREATED = {
  order: { ...ORDER, status: 'PENDING_PAYMENT', paidAt: null, vestedAt: null },
  paymentUrl: 'https://pay.oxapay.com/1234567',
};

/** deliveryInfo appears ONLY here: caller is the buyer and the order is PAID/DISPUTED/REFUNDED. */
export const ORDER_DETAIL = {
  ...ORDER,
  deliveryInfo:
    'Send me the Gmail address on your Google account. The invite arrives in 30 min.',
};

export const BALANCE = {
  available: '47.02',
  vesting: '32.29',
  disputed: '16.62',
  withdrawing: '0.00',
  withdrawn: '23.74',
  nextVestingAt: '2026-09-17T09:00:00.000Z',
};

export const WALLET_ORDERS = [
  {
    orderId: 'ord_available_1',
    title: 'Spotify Premium Individual — 6 months',
    amount: '16.62',
    status: 'PAID',
    vestedAt: '2026-08-15T09:00:00.000Z',
    bucket: 'available',
    disputeStatus: null,
    withdrawalId: null,
  },
  {
    orderId: 'ord_disputed_1',
    title: 'Spotify Premium Individual — 6 months',
    amount: '16.62',
    status: 'DISPUTED',
    vestedAt: '2026-09-23T09:00:00.000Z',
    bucket: 'disputed',
    disputeStatus: 'OPEN',
    withdrawalId: null,
  },
];

export const WITHDRAWAL = {
  id: 'cmf3k9z1x0000q1x8t4v6b2n0',
  amountUsd: '47.02',
  currency: 'USDT',
  network: 'TRC20',
  address: 'TQn9Y2khDD95J42FQtQTdwVVR93DemoAddr',
  status: 'PROCESSING',
  oxapayTrackId: '99871234',
  error: null,
  completedAt: null,
  createdAt: '2026-08-30T09:20:00.000Z',
  orderCount: 2,
};

export const WITHDRAWAL_CREATED = {
  ...WITHDRAWAL,
  userId: USER_STUB.id,
  updatedAt: '2026-08-30T09:20:01.000Z',
  orderIds: ['ord_available_1', 'ord_refunded_1'],
};

export const DISPUTE = {
  id: 'dsp_open_1',
  orderId: 'ord_disputed_1',
  openedById: 'cmf3k1a2b0003q1x8m9r4t2y7',
  reason: 'The redeem code was already used when I tried it.',
  status: 'OPEN',
  telegramChatId: '-1002345678901',
  telegramInviteLink: 'https://t.me/+AbCdEfGhIjKlMnOp',
  resolvedById: null,
  resolutionNote: null,
  resolvedAt: null,
  createdAt: '2026-08-26T11:04:00.000Z',
  updatedAt: '2026-08-26T11:04:06.000Z',
  order: {
    id: 'ord_disputed_1',
    titleSnapshot: 'Spotify Premium Individual — 6 months',
    amountUsd: '17.50',
    sellerAmountUsd: '16.62',
    status: 'DISPUTED',
    buyerId: 'cmf3k1a2b0003q1x8m9r4t2y7',
    sellerId: USER_STUB.id,
    paidAt: '2026-08-24T11:00:00.000Z',
    vestedAt: '2026-09-23T11:00:00.000Z',
  },
};

export const DISPUTE_CREATED = {
  dispute: DISPUTE,
  telegramInviteLink: 'https://t.me/+AbCdEfGhIjKlMnOp',
};

export const ADMIN_DISPUTE = {
  ...DISPUTE,
  openedBy: {
    id: 'cmf3k1a2b0003q1x8m9r4t2y7',
    email: 'priya.nair@example.com',
    username: 'Priya Nair',
  },
  resolvedBy: null,
  order: {
    id: 'ord_disputed_1',
    titleSnapshot: 'Spotify Premium Individual — 6 months',
    amountUsd: '17.50',
    feeUsd: '0.88',
    sellerAmountUsd: '16.62',
    status: 'DISPUTED',
    paidAt: '2026-08-24T11:00:00.000Z',
    vestedAt: '2026-09-23T11:00:00.000Z',
    withdrawalId: null,
    beneficiaryId: USER_STUB.id,
    buyer: {
      id: 'cmf3k1a2b0003q1x8m9r4t2y7',
      email: 'priya.nair@example.com',
      username: 'Priya Nair',
    },
    seller: USER_STUB_EMAIL,
  },
};

export const ADMIN_DISPUTE_PAGE = {
  items: [ADMIN_DISPUTE],
  total: 2,
  page: 1,
  limit: 20,
  pages: 1,
};

export const ADMIN_ORDER = {
  id: 'ord_disputed_1',
  titleSnapshot: 'Spotify Premium Individual — 6 months',
  amountUsd: '17.50',
  feeUsd: '0.88',
  sellerAmountUsd: '16.62',
  status: 'DISPUTED',
  beneficiaryId: USER_STUB.id,
  oxapayTrackId: 'seed_track_ord_disputed_1',
  paidAt: '2026-08-24T11:00:00.000Z',
  vestedAt: '2026-09-23T11:00:00.000Z',
  withdrawalId: null,
  createdAt: '2026-08-24T10:58:00.000Z',
  buyer: {
    id: 'cmf3k1a2b0003q1x8m9r4t2y7',
    email: 'priya.nair@example.com',
    username: 'Priya Nair',
  },
  seller: USER_STUB_EMAIL,
  dispute: { id: 'dsp_open_1', status: 'OPEN' },
};

export const ADMIN_ORDER_PAGE = {
  items: [ADMIN_ORDER],
  total: 10,
  page: 1,
  limit: 20,
  pages: 1,
};

export const ADMIN_WITHDRAWAL_PAGE = {
  items: [{ ...WITHDRAWAL, status: 'COMPLETED', user: USER_STUB_EMAIL }],
  total: 1,
  page: 1,
  limit: 20,
  pages: 1,
};

export const DISPUTE_RESOLVED = {
  dispute: { ...ADMIN_DISPUTE, status: 'RESOLVED_BUYER' },
  order: { ...ADMIN_ORDER, status: 'REFUNDED' },
};

export const ADMIN_STATS = {
  users: 5,
  listings: 8,
  orders: {
    total: 10,
    byStatus: {
      PENDING_PAYMENT: 2,
      PAID: 6,
      DISPUTED: 1,
      REFUNDED: 1,
      EXPIRED: 0,
    },
  },
  disputes: {
    total: 2,
    open: 1,
    byStatus: { OPEN: 1, RESOLVED_BUYER: 1, RESOLVED_SELLER: 0 },
  },
  money: {
    grossVolumeUsd: '204.48',
    platformFeesUsd: '10.25',
    inEscrowUsd: '146.28',
    paidOutUsd: '23.74',
  },
};

export const HEALTH = { status: 'ok', db: 'up' };
