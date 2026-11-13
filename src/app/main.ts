import { Bot } from "../bot/bot.js";
import { Reporter } from "../bot/reporter.js";
import { env } from "../config/env.js";
import { escapeHtml, formatDurationMs } from "../core/format.js";
import { log } from "../core/logger.js";
import { StateStore } from "../storage/state-store.js";
import { TokenQueueStore } from "../storage/token-queue-store.js";
import { registerCommands } from "../telegram/commands.js";
import { Telegram } from "../telegram/telegram.js";

async function main(): Promise<void> {
  const telegram = new Telegram(env.telegram.botToken, env.telegram.chatId);
  log.setAlertSink((text) => telegram.send(escapeHtml(text)));

  const store = StateStore.open();
  const bot = new Bot(store, TokenQueueStore.open(), new Reporter(telegram));
  let shuttingDown = false;

  const shutdown = async (reason: string, code = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.alert(`token-launch-bot stopping: ${reason}`);
    telegram.stop();
    bot.stop();
    await store
      .flush()
      .catch((error) => log.error("state flush failed", error));
    await telegram.flush();
    await log.close();
    process.exit(code);
  };

  registerCommands(telegram, bot, (reason) => void shutdown(reason));
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void shutdown(signal));
  }
  process.on("uncaughtException", (error) => {
    log.alertError("uncaught exception", error);
    void shutdown("uncaught exception", 1);
  });
  process.on("unhandledRejection", (reason) => {
    log.alertError("unhandled rejection", reason);
    void shutdown("unhandled rejection", 1);
  });

  const withdrawRpc = env.chains
    .map(
      (key) =>
        `${key} ${(env.withdrawRpcUrls[key]?.length ?? 0) > 0 ? "on" : "off"}`,
    )
    .join(", ");
  log.alert(
    [
      "token-launch-bot starting",
      `Wallet: ${bot.wallet}`,
      `Chains: ${env.chains.join(", ")}`,
      `Tokens: ${env.tokens
        .map((token) => `${token.name} (${token.symbol}), supply ${token.supply}`)
        .join(", ")}`,
      `Pool: $${env.poolUsd}`,
      `Pool lifetime: ${formatDurationMs(env.poolLifetimeMs)}`,
      `Deploy cooldown: ${formatDurationMs(env.deployCooldownMs)}`,
      `Withdraw RPC: ${withdrawRpc}`,
      `Telegram: ${telegram.enabled ? "on" : "off"}`,
    ].join("\n"),
  );

  await telegram.start();
  await bot.start();
}

main().catch(async (error) => {
  log.alertError("startup failed", error);
  await log.close();
  process.exit(1);
});
