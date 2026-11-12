import { parseGwei } from "viem";
import { base as baseChain } from "viem/chains";
import type { ChainConfig } from "../types.js";

export const base: ChainConfig = {
  key: "base",
  chain: baseChain,
  nativeSymbol: "ETH",
  dexscreenerSlug: "base",
  dex: {
    name: "Uniswap V2",
    router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    wrappedNative: "0x4200000000000000000000000000000000000006",
  },
  priceFeed: {
    address: "0xa4250cE1aA15Ff4cb5E5a8655293b65694e436Ed",
    decimals: 8,
    maxAgeSec: 3_600,
  },
  blockTimeMs: 2_000,
  pollingIntervalMs: 250,
  maxLogRange: 1_000n,
  fees: {
    priorityMultiplierPct: 150n,
    minPriorityFee: parseGwei("0.01"),
    withdrawPriorityMultiplierPct: 250n,
    withdrawMinPriorityFee: parseGwei("0.05"),
    withdrawBaseFeeMultiplier: 3n,
  },
};
