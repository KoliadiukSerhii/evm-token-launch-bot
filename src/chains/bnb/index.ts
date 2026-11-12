import { parseGwei } from "viem";
import { bsc } from "viem/chains";
import type { ChainConfig } from "../types.js";

export const bnb: ChainConfig = {
  key: "bnb",
  chain: bsc,
  nativeSymbol: "BNB",
  dexscreenerSlug: "bsc",
  dex: {
    name: "PancakeSwap V2",
    router: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
    wrappedNative: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  },
  priceFeed: {
    address: "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE",
    decimals: 8,
    maxAgeSec: 600,
  },
  blockTimeMs: 450,
  pollingIntervalMs: 200,
  maxLogRange: 1_000n,
  fees: {
    priorityMultiplierPct: 100n,
    minPriorityFee: parseGwei("0.1"),
    withdrawPriorityMultiplierPct: 200n,
    withdrawMinPriorityFee: parseGwei("0.5"),
    withdrawBaseFeeMultiplier: 2n,
  },
};
