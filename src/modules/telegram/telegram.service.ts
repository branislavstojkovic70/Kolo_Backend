import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';

export interface DisputeGroupInput {
  disputeId: string;
  orderId: string;
  listingTitle: string;
  amountUsd: string;
  buyerEmail: string;
  sellerEmail: string;
  reason: string;
}

export interface DisputeGroupResult {
  chatId: string;
  inviteLink: string;
}

/**
 * Hard ceiling on any Telegram round trip. GramJS will happily retry a dead or
 * mis-authenticated DC for minutes; a dispute request must never wait on that.
 */
const TELEGRAM_TIMEOUT_MS = Number(process.env.TELEGRAM_TIMEOUT_MS ?? 15000);

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);

  /** Created lazily on first use and reused for the process lifetime. Never per request. */
  private client: TelegramClient | null = null;
  private connecting: Promise<TelegramClient> | null = null;

  constructor(private readonly config: ConfigService) {}

  /** No StringSession → mock. Generating one is a manual, offline step. */
  private get isMock(): boolean {
    return !this.config.get<string>('telegram.session');
  }

  private async getClient(): Promise<TelegramClient> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const apiId = this.config.get<number>('telegram.apiId') as number;
      const apiHash = this.config.get<string>('telegram.apiHash') as string;
      const session = this.config.get<string>('telegram.session') as string;

      const client = new TelegramClient(
        new StringSession(session),
        apiId,
        apiHash,
        {
          connectionRetries: 3,
        },
      );
      await client.connect();

      this.logger.log('MTProto client connected');
      this.client = client;
      return client;
    })();

    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private openingMessage(d: DisputeGroupInput): string {
    return [
      `⚖️ Dispute opened`,
      ``,
      `Order: ${d.orderId}`,
      `Item: ${d.listingTitle}`,
      `Amount: $${d.amountUsd}`,
      `Buyer: ${d.buyerEmail}`,
      `Seller: ${d.sellerEmail}`,
      ``,
      `Reason: ${d.reason}`,
      ``,
      `Buyer and seller: please state your case here. An admin will decide the outcome.`,
    ].join('\n');
  }

  private groupTitle(d: DisputeGroupInput): string {
    return `Dispute #${d.disputeId.slice(-6)} — ${d.listingTitle}`.slice(
      0,
      128,
    );
  }

  private withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
    return Promise.race([
      work,
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(`${label} timed out after ${TELEGRAM_TIMEOUT_MS}ms`),
            ),
          TELEGRAM_TIMEOUT_MS,
        ).unref(),
      ),
    ]);
  }

  private isFloodWait(e: any): number | null {
    const msg = String(e?.errorMessage ?? e?.message ?? '');
    const m = msg.match(/FLOOD_WAIT_(\d+)/);
    if (m) return Number(m[1]);
    if (typeof e?.seconds === 'number' && /flood/i.test(msg)) return e.seconds;
    return null;
  }

  /**
   * Creates a real group containing the admins + the bot ONLY.
   * Buyer and seller are never added programmatically — they join via the invite link.
   */
  async createDisputeGroup(d: DisputeGroupInput): Promise<DisputeGroupResult> {
    if (this.isMock) return this.mockGroup(d);

    try {
      return await this.withTimeout(
        this.createDisputeGroupLive(d),
        'createDisputeGroup',
      );
    } catch (e) {
      const flood = this.isFloodWait(e);
      if (flood) {
        this.logger.error(
          `FLOOD_WAIT_${flood} creating the group — Telegram wants ${flood}s`,
        );
      }
      throw e;
    }
  }

  private mockGroup(d: DisputeGroupInput): DisputeGroupResult {
    const title = this.groupTitle(d);
    const message = this.openingMessage(d);
    const mock: DisputeGroupResult = {
      chatId: `mock_${randomUUID()}`,
      inviteLink: 'https://t.me/+mockInviteLink',
    };
    this.logger.warn(
      `*** TELEGRAM MOCK *** no real group created (TELEGRAM_SESSION is empty). ` +
        `Would have created "${title}" and posted:\n${message}\n— returning ${JSON.stringify(mock)}`,
    );
    return mock;
  }

  private async createDisputeGroupLive(
    d: DisputeGroupInput,
  ): Promise<DisputeGroupResult> {
    const title = this.groupTitle(d);
    const message = this.openingMessage(d);

    const botUsername = this.config.get<string>('telegram.botUsername');
    const adminUsernames =
      this.config.get<string[]>('telegram.adminUsernames') ?? [];
    const invitees = [...adminUsernames, ...(botUsername ? [botUsername] : [])];

    const client = await this.getClient();

    // 1. Create the chat with admins + bot only.
    const created: any = await client.invoke(
      new Api.messages.CreateChat({ users: invitees, title }),
    );

    // Newer TL layers wrap the Updates in messages.InvitedUsers and report who
    // could not be added. We log those and carry on — the bot alone can run the group.
    const updates = created?.updates ?? created;
    const missing = created?.missingInvitees ?? [];
    if (missing.length) {
      this.logger.warn(
        `Could not add ${missing.length} invitee(s) to "${title}" — continuing anyway`,
      );
    }

    const chat = updates?.chats?.[0];
    if (!chat?.id) {
      throw new Error(
        `CreateChat returned no chat id: ${JSON.stringify(updates?.className)}`,
      );
    }
    // Basic groups get auto-upgraded to supergroups and the id changes — store whatever
    // the API gave us and treat the invite link as the durable handle.
    const chatId = String(chat.id);

    // 2. Promote the bot and each admin. A failure here must not abort the group.
    for (const username of invitees) {
      try {
        await client.invoke(
          new Api.messages.EditChatAdmin({
            chatId: chat.id,
            userId: username,
            isAdmin: true,
          }),
        );
      } catch (e) {
        const flood = this.isFloodWait(e);
        this.logger.warn(
          flood
            ? `FLOOD_WAIT_${flood} promoting @${username} — skipping promotion`
            : `Could not promote @${username}: ${e?.message} — continuing`,
        );
      }
    }

    // 3. Export the invite link. This is the only way buyer and seller get in,
    //    so a failure here must fail the whole call and leave the fields null.
    const invite: any = await client.invoke(
      new Api.messages.ExportChatInvite({ peer: chat.id }),
    );
    const inviteLink: string | undefined = invite?.link;
    if (!inviteLink) {
      throw new Error('ExportChatInvite returned no link');
    }

    // 4. Opening message.
    try {
      await client.sendMessage(chat.id, { message });
    } catch (e) {
      this.logger.warn(
        `Could not post the opening message to ${chatId}: ${e?.message}`,
      );
    }

    this.logger.log(
      `Created dispute group ${chatId} for dispute ${d.disputeId}`,
    );
    return { chatId, inviteLink };
  }

  /**
   * Posts into an existing dispute group with the plain Bot API — the bot is already
   * a member, so this needs no MTProto.
   */
  async postToDisputeGroup(chatId: string, text: string): Promise<void> {
    const token = this.config.get<string>('telegram.botToken');

    if (!token || chatId.startsWith('mock_')) {
      this.logger.warn(
        `*** TELEGRAM MOCK *** would have posted to chat ${chatId}:\n${text}`,
      );
      return;
    }

    // MTProto hands back a bare positive id; the Bot API wants it negated
    // (and -100-prefixed once the group is upgraded to a supergroup).
    const botApiChatId = chatId.startsWith('-') ? chatId : `-${chatId}`;
    // This conversion has never been exercised against a live group. If the send
    // below 400s with "chat not found", try the supergroup form logged here by hand.
    this.logger.log(
      `Bot API chat id: raw="${chatId}" → converted="${botApiChatId}" ` +
        `(supergroup alternative would be "-100${chatId.replace(/^-(100)?/, '')}")`,
    );

    try {
      const res = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: botApiChatId, text }),
          signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
        },
      );
      const body = await res.text();
      this.logger.log(
        `Bot API sendMessage to ${botApiChatId} ← ${res.status} ${body}`,
      );
      if (!res.ok) {
        this.logger.error(`Bot API sendMessage failed: ${res.status} ${body}`);
      }
    } catch (e) {
      this.logger.error(`Bot API sendMessage threw: ${e?.message}`);
    }
  }
}
