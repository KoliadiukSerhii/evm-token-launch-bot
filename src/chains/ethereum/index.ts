import { parseGwei } from "viem";
import { mainnet } from "viem/chains";
import type { ChainConfig } from "../types.js";

export const ethereum: ChainConfig = {
  key: "ethereum",
  chain: mainnet,
  nativeSymbol: "ETH",
  dexscreenerSlug: "ethereum",
  dex: {
    name: "Uniswap V2",
    router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    wrappedNative: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  },
  priceFeed: {
    address: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
    decimals: 8,
    maxAgeSec: 7_200,
  },
  blockTimeMs: 12_000,
  pollingIntervalMs: 1_000,
  maxLogRange: 1_000n,
  fees: {
    priorityMultiplierPct: 150n,
    minPriorityFee: parseGwei("0.2"),
    withdrawPriorityMultiplierPct: 300n,
    withdrawMinPriorityFee: parseGwei("1"),
    withdrawBaseFeeMultiplier: 3n,
  },
};
