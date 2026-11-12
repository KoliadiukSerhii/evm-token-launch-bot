import type { Address, Chain } from "viem";

export const CHAIN_KEYS = ["ethereum", "base", "bnb"] as const;
export type ChainKey = (typeof CHAIN_KEYS)[number];

export function isChainKey(value: string): value is ChainKey {
  return (CHAIN_KEYS as readonly string[]).includes(value);
}

export interface ChainConfig {
  key: ChainKey;
  chain: Chain;
  nativeSymbol: string;
  dexscreenerSlug: string;
  dex: {
    name: string;
    router: Address;
    wrappedNative: Address;
  };
  priceFeed: {
    address: Address;
    decimals: number;
    maxAgeSec: number;
  };
  blockTimeMs: number;
  pollingIntervalMs: number;
  maxLogRange: bigint;
  fees: {
    priorityMultiplierPct: bigint;
    minPriorityFee: bigint;
    /** Used for remove-liquidity (pool shutdown) transactions. */
    withdrawPriorityMultiplierPct: bigint;
    withdrawMinPriorityFee: bigint;
    withdrawBaseFeeMultiplier: bigint;
  };
}
