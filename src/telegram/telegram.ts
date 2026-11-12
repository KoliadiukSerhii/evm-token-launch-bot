import { describeError } from "../core/errors.js";
import { escapeHtml } from "../core/format.js";
import { log } from "../core/logger.js";
import { sleep } from "../core/time.js";

const API = "https://api.telegram.org";
const MAX_MESSAGE_LENGTH = 4_000;
const MAX_QUEUE_LENGTH = 200;
const SEND_INTERVAL_MS = 1_100;
const LONG_POLL_SEC = 25;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_POLL_BACKOFF_MS = 60_000;

interface TelegramMessage {
  text?: string;
  chat: { id: number };
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  channel_post?: TelegramMessage;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  parameters?: { retry_after?: number };
}

class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

export interface Command {
  name: string;
  description: string;
  usage?: string;
  handler: (args: string[]) => Promise<string>;
}

export class Telegram {
  private readonly queue: string[] = [];
  private readonly commands = new Map<string, Command>();
  private sending = false;
  private polling = false;
  private offset = 0;
  private poller: AbortController | null = null;

  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
  ) {}

  get enabled(): boolean {
    return this.botToken.length > 0 && this.chatId.length > 0;
  }

  register(command: Command): void {
    this.commands.set(command.name, command);
  }

  help(): string {
    return [...this.commands.values()]
      .map(
        (c) =>
          `/${c.name}${c.usage ? ` ${escapeHtml(c.usage)}` : ""} — ${escapeHtml(c.description)}`,
      )
      .join("\n");
  }

  send(html: string): void {
    if (!this.enabled) return;
    this.queue.push(
      html.length > MAX_MESSAGE_LENGTH
        ? `${html.slice(0, MAX_MESSAGE_LENGTH)}…`
        : html,
    );
    if (this.queue.length > MAX_QUEUE_LENGTH) this.queue.shift();
    void this.drain();
  }

  async start(): Promise<void> {
    if (!this.enabled || this.polling) return;
    await this.call("setMyCommands", {
      commands: [...this.commands.values()].map((c) => ({
        command: c.name,
        description: c.description,
      })),
    }).catch((error) =>
      log.warn("telegram setMyCommands failed", {
        error: describeError(error),
      }),
    );
    const backlog = await this.call<TelegramUpdate[]>("getUpdates", {
      offset: -1,
      timeout: 0,
    }).catch(() => []);
    const last = backlog.at(-1);
    if (last) this.offset = last.update_id + 1;

    this.polling = true;
    void this.poll();
  }

  stop(): void {
    this.polling = false;
    this.poller?.abort();
  }

  async flush(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while ((this.queue.length > 0 || this.sending) && Date.now() < deadline) {
      await sleep(50);
    }
  }

  private async drain(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length > 0) {
        const text = this.queue[0]!;
        try {
          await this.call("sendMessage", {
            chat_id: this.chatId,
            text,
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
          });
          this.queue.shift();
        } catch (error) {
          if (error instanceof TelegramApiError && error.retryAfterSec) {
            await sleep(error.retryAfterSec * 1_000);
            continue;
          }
          this.queue.shift();
          log.warn("telegram send failed", { error: describeError(error) });
        }
        await sleep(SEND_INTERVAL_MS);
      }
    } finally {
      this.sending = false;
    }
  }

  private async poll(): Promise<void> {
    let failures = 0;
    while (this.polling) {
      this.poller = new AbortController();
      try {
        const updates = await this.call<TelegramUpdate[]>(
          "getUpdates",
          {
            offset: this.offset,
            timeout: LONG_POLL_SEC,
            allowed_updates: ["message", "channel_post"],
          },
          AbortSignal.any([
            this.poller.signal,
            AbortSignal.timeout((LONG_POLL_SEC + 10) * 1_000),
          ]),
        );
        failures = 0;
        for (const update of updates) {
          this.offset = update.update_id + 1;
          this.dispatch(update);
        }
      } catch (error) {
        if (!this.polling) return;
        failures++;
        if (failures === 3) {
          log.warn("telegram polling is failing", {
            error: describeError(error),
          });
        }
        await sleep(Math.min(1_000 * 2 ** failures, MAX_POLL_BACKOFF_MS));
      }
    }
  }

  private dispatch(update: TelegramUpdate): void {
    const message = update.message ?? update.channel_post;
    const text = message?.text?.trim();
    if (!text?.startsWith("/") || String(message?.chat.id) !== this.chatId) {
      return;
    }
    const [head = "", ...args] = text.split(/\s+/);
    const name = head.slice(1).split("@")[0]!.toLowerCase();
    const command = this.commands.get(name);
    if (!command) {
      this.send(`Unknown command /${escapeHtml(name)}\n\n${this.help()}`);
      return;
    }
    log.info(`telegram command /${name}`, { args });
    command
      .handler(args)
      .then((reply) => reply && this.send(reply))
      .catch((error) => {
        log.error(`telegram command /${name} failed`, error);
        this.send(`❌ /${name}: ${escapeHtml(describeError(error))}`);
      });
  }

  private async call<T = unknown>(
    method: string,
    body: object,
    signal: AbortSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  ): Promise<T> {
    const response = await fetch(`${API}/bot${this.botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const payload = (await response.json()) as TelegramResponse<T>;
    if (!payload.ok) {
      throw new TelegramApiError(
        `${method}: ${payload.description ?? response.status}`,
        payload.parameters?.retry_after,
      );
    }
    return payload.result as T;
  }
}
