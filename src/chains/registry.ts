import { base } from "./base/index.js";
import { bnb } from "./bnb/index.js";
import { ethereum } from "./ethereum/index.js";
import type { ChainConfig, ChainKey } from "./types.js";

export const CHAINS: Record<ChainKey, ChainConfig> = { ethereum, base, bnb };

export function rpcEnvName(key: ChainKey): string {
  return `${key.toUpperCase()}_RPC_URLS`;
}

export function withdrawRpcEnvName(key: ChainKey): string {
  return `${key.toUpperCase()}_WITHDRAW_RPC_URLS`;
}
