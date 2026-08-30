export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  publicApiUrl: process.env.PUBLIC_API_URL ?? 'http://localhost:3000',
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:3001',

  clerk: {
    secretKey: process.env.CLERK_SECRET_KEY,
    publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
  },

  adminEmails: (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),

  oxapay: {
    merchantApiKey: process.env.OXAPAY_MERCHANT_API_KEY,
    payoutApiKey: process.env.OXAPAY_PAYOUT_API_KEY,
    sandbox: process.env.OXAPAY_SANDBOX === 'true',
  },

  telegram: {
    apiId: parseInt(process.env.TELEGRAM_API_ID ?? '0', 10),
    apiHash: process.env.TELEGRAM_API_HASH,
    session: process.env.TELEGRAM_SESSION,
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    botUsername: process.env.TELEGRAM_BOT_USERNAME,
    adminUsernames: (process.env.TELEGRAM_ADMIN_USERNAMES ?? '')
      .split(',')
      .map((u) => u.trim().replace(/^@/, ''))
      .filter(Boolean),
  },

  vestingDays: parseInt(process.env.VESTING_DAYS ?? '30', 10),
  disputeWindowDays: parseInt(process.env.DISPUTE_WINDOW_DAYS ?? '30', 10),
  platformFeePercent: parseFloat(process.env.PLATFORM_FEE_PERCENT ?? '5'),
  minWithdrawalUsd: parseFloat(process.env.MIN_WITHDRAWAL_USD ?? '1'),
});
