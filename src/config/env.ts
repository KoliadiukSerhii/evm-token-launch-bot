import "dotenv/config";
import type { Hex } from "viem";
import { rpcEnvName, withdrawRpcEnvName } from "../chains/registry.js";
import { type ChainKey, CHAIN_KEYS, isChainKey } from "../chains/types.js";
import { parseTokenEntry } from "../core/token-spec.js";
import type { TokenSpec } from "../domain/types.js";

function list(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function requiredList(name: string): string[] {
  const values = list(name);
  if (values.length === 0) throw new Error(`${name} is required`);
  return values;
}

function parseChains(): ChainKey[] {
  const keys = requiredList("CHAINS").map((key) => key.toLowerCase());
  for (const key of keys) {
    if (!isChainKey(key)) {
      throw new Error(
        `CHAINS: unknown chain "${key}", available: ${CHAIN_KEYS.join(", ")}`,
      );
    }
  }
  return [...new Set(keys as ChainKey[])];
}

function parseToken(entry: string): TokenSpec {
  try {
    return parseTokenEntry(entry);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`TOKENS: ${message}`);
  }
}

function parseTokens(): TokenSpec[] {
  const tokens = requiredList("TOKENS").map(parseToken);
  const symbols = tokens.map((token) => token.symbol);
  const duplicate = symbols.find((s, i) => symbols.indexOf(s) !== i);
  if (duplicate) throw new Error(`TOKENS: duplicate symbol ${duplicate}`);
  return tokens;
}

function parsePoolUsd(): number {
  const raw = process.env["POOL_USD"]?.trim() ?? "";
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`POOL_USD must be a positive integer, got "${raw}"`);
  }
  return Number(raw);
}

function parsePrivateKey(): Hex {
  const raw = process.env["PRIVATE_KEY"]?.trim() ?? "";
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("PRIVATE_KEY must be a 32-byte hex string");
  }
  return key as Hex;
}

const DURATION_UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

function parsePoolLifetimeMs(): number {
  const raw = process.env["POOL_LIFETIME"]?.trim() ?? "24h";
  const match = /^(\d+)([smhd])?$/i.exec(raw);
  if (!match) {
    throw new Error(
      `POOL_LIFETIME must look like "24h", "3d", or "3600s", got "${raw}"`,
    );
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? "h").toLowerCase();
  const ms = amount * DURATION_UNITS[unit]!;
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`POOL_LIFETIME must be positive, got "${raw}"`);
  }
  return ms;
}

const chains = parseChains();

export const env = {
  chains,
  tokens: parseTokens(),
  poolUsd: parsePoolUsd(),
  poolLifetimeMs: parsePoolLifetimeMs(),
  privateKey: parsePrivateKey(),
  rpcUrls: Object.fromEntries(
    chains.map((key) => [key, requiredList(rpcEnvName(key))]),
  ) as Partial<Record<ChainKey, string[]>>,
  withdrawRpcUrls: Object.fromEntries(
    chains.map((key) => [key, list(withdrawRpcEnvName(key))]),
  ) as Partial<Record<ChainKey, string[]>>,
  telegram: {
    botToken: process.env["TELEGRAM_BOT_TOKEN"]?.trim() ?? "",
    chatId: process.env["TELEGRAM_CHAT_ID"]?.trim() ?? "",
  },
} as const;
