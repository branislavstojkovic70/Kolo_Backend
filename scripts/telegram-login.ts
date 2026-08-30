/**
 * ONE-OFF, RUN BY HAND:  npm run telegram:login
 *
 * Logs the platform "support" account in once and prints a StringSession.
 * Paste the printed value into TELEGRAM_SESSION in your .env.
 *
 * This file is never imported by the app and never runs during a request.
 */
import 'dotenv/config';
import { createInterface } from 'readline';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';

const rl = createInterface({ input: process.stdin, output: process.stdout });

const ask = (question: string): Promise<string> =>
  new Promise((resolve) => rl.question(question, (a) => resolve(a.trim())));

async function main() {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;

  if (!apiId || !apiHash) {
    console.error(
      'Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env first (get them from https://my.telegram.org).',
    );
    process.exit(1);
  }

  console.log('\nLogging in the support account. Have your phone handy.\n');

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 3,
  });

  await client.start({
    phoneNumber: () => ask('Phone number (international format, e.g. +3816...): '),
    phoneCode: () => ask('Login code Telegram just sent you: '),
    password: () => ask('2FA password (press Enter if you have none): '),
    onError: (err) => console.error('Login error:', err?.message ?? err),
  });

  const session = (client.session as StringSession).save();

  console.log('\n─────────────────────────────────────────────');
  console.log('TELEGRAM_SESSION=' + session);
  console.log('─────────────────────────────────────────────');
  console.log('\nCopy that whole line into your .env, then restart the API.\n');

  await client.disconnect();
  rl.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  rl.close();
  process.exit(1);
});
