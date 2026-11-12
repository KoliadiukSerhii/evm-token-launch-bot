import { isChainKey } from "../chains/types.js";
import type { Bot } from "../bot/bot.js";
import { env } from "../config/env.js";
import type { Telegram } from "./telegram.js";

function splitChain(args: string[]): { body: string[]; chain?: string } {
  const last = args.at(-1)?.toLowerCase();
  if (last && isChainKey(last) && env.chains.includes(last) && args.length > 1) {
    return { body: args.slice(0, -1), chain: last };
  }
  return { body: args };
}

export function registerCommands(
  telegram: Telegram,
  bot: Bot,
  shutdown: (reason: string) => void,
): void {
  telegram.register({
    name: "status",
    description: "Pools, queue, and shutdown timer on every chain",
    handler: () => bot.status(),
  });
  telegram.register({
    name: "balance",
    description: "Wallet balance on every chain",
    handler: () => bot.balances(),
  });
  telegram.register({
    name: "deploy",
    description: "Deploy the next queued token, or a symbol, per chain",
    usage: "[SYMBOL] [chain]",
    handler: async (args) => {
      const { body, chain } = splitChain(args);
      const symbol = body[0];
      if (body.length > 1) {
        return `Usage: /deploy [SYMBOL] [chain]\nChains: ${env.chains.join(", ")}`;
      }
      return bot.deploy(symbol, chain);
    },
  });
  telegram.register({
    name: "add_token",
    description: "Put a token at the front of the deploy queue",
    usage: "<Name:SYMBOL[:supply]> [chain]",
    handler: async (args) => {
      const { body, chain } = splitChain(args);
      const entry = body.join(" ").trim();
      if (!entry.includes(":")) {
        return "Usage: /add_token &lt;Name:SYMBOL&gt; or &lt;Name:SYMBOL:supply&gt; [chain]";
      }
      return bot.addToken(entry, chain);
    },
  });
  telegram.register({
    name: "set_token_order",
    description: "Move a queued token to an index (0 = first)",
    usage: "<SYMBOL>:<INDEX> [chain]",
    handler: async (args) => {
      const { body, chain } = splitChain(args);
      const raw = body.join("").trim();
      if (!raw) return "Usage: /set_token_order &lt;SYMBOL&gt;:&lt;INDEX&gt; [chain]";
      return bot.setTokenOrder(raw, chain);
    },
  });
  telegram.register({
    name: "canceltimer",
    description: "Cancel auto pool shutdown",
    usage: "<SYMBOL> [chain]",
    handler: async (args) => {
      const { body, chain } = splitChain(args);
      const symbol = body[0];
      if (!symbol) return "Usage: /canceltimer &lt;SYMBOL&gt; [chain]";
      return bot.cancelTimer(symbol, chain);
    },
  });
  telegram.register({
    name: "sell_all",
    description: "Sell the whole position and close the pool",
    usage: "[SYMBOL] [chain]",
    handler: async (args) => {
      const { body, chain } = splitChain(args);
      if (body.length > 1) {
        return `Usage: /sell_all [SYMBOL] [chain]\nChains: ${env.chains.join(", ")}`;
      }
      return bot.sellAll(body[0], chain);
    },
  });
  telegram.register({
    name: "sell_tokens_in_percent",
    description: "Sell % of the token balance; from 75% also closes the pool",
    usage: "<1-100> [chain]",
    handler: async (args) => {
      const { body, chain } = splitChain(args);
      const raw = body[0];
      if (!raw || !/^\d+$/.test(raw) || body.length > 1) {
        return `Usage: /sell_tokens_in_percent &lt;1-100&gt; [chain]\nChains: ${env.chains.join(", ")}`;
      }
      return bot.sellTokensInPercent(Number(raw), chain);
    },
  });
  telegram.register({
    name: "buy_tokens_in_sol",
    description: "Buy the live token for the chain's native coin (ETH or BNB)",
    usage: "<amount> [chain]",
    handler: async (args) => buyNative(bot, args),
  });
  telegram.register({
    name: "health",
    description: "RPC, balance, queue, and exit state per chain",
    handler: () => bot.health(),
  });
  telegram.register({
    name: "mute_exit_detail",
    description: "Hide step-by-step exit logs (failures stay on)",
    handler: async () => {
      bot.exitDetailAlerts = false;
      return "🔕 Exit detail muted (failures and the final exit stay on)";
    },
  });
  telegram.register({
    name: "unmute_exit_detail",
    description: "Show step-by-step exit logs",
    handler: async () => {
      bot.exitDetailAlerts = true;
      return "🔔 Exit detail enabled";
    },
  });
  telegram.register({
    name: "mute",
    description: "Stop buy/sell notifications",
    handler: async () => {
      bot.tradeAlerts = false;
      return "🔕 Trade notifications muted";
    },
  });
  telegram.register({
    name: "unmute",
    description: "Resume buy/sell notifications",
    handler: async () => {
      bot.tradeAlerts = true;
      return "🔔 Trade notifications enabled";
    },
  });
  telegram.register({
    name: "stop",
    description: "Stop the bot",
    handler: async () => {
      setImmediate(() => shutdown("Telegram /stop command"));
      return "⏹ Stopping…";
    },
  });
  telegram.register({
    name: "help",
    description: "List commands",
    handler: async () => telegram.help(),
  });
}

function buyNative(bot: Bot, args: string[]): Promise<string> {
  const { body, chain } = splitChain(args);
  const raw = body[0];
  if (!raw || !/^\d+(\.\d{1,18})?$/.test(raw) || body.length > 1) {
    return Promise.resolve(
      `Usage: /buy_tokens_in_sol &lt;amount&gt; [chain]\nAmount is ETH on Ethereum/Base and BNB on BNB Chain. Minimum 0.001.\nChains: ${env.chains.join(", ")}`,
    );
  }
  return bot.buyTokensInNative(raw, chain);
}
