import { priceFeedAbi } from "../abi/index.js";
import { describeError } from "../core/errors.js";
import { log } from "../core/logger.js";
import type { EvmClient } from "../evm/evm-client.js";

const CACHE_TTL_MS = 30_000;
const NATIVE_DECIMALS = 18n;

export interface NativePrice {
  answer: bigint;
  decimals: number;
  usd: number;
}

export class NativePriceOracle {
  private cached: { price: NativePrice; fetchedAt: number } | null = null;
  private inflight: Promise<NativePrice> | null = null;

  constructor(private readonly evm: EvmClient) {}

  fresh(): Promise<NativePrice> {
    this.inflight ??= this.read().finally(() => (this.inflight = null));
    return this.inflight;
  }

  async usd(): Promise<number | null> {
    if (this.cached && Date.now() - this.cached.fetchedAt < CACHE_TTL_MS) {
      return this.cached.price.usd;
    }
    try {
      return (await this.fresh()).usd;
    } catch (error) {
      log.warn(`[${this.evm.config.key}] native price unavailable`, {
        error: describeError(error),
      });
      return this.cached?.price.usd ?? null;
    }
  }

  toNative(usd: number, price: NativePrice): bigint {
    return (
      (BigInt(usd) * 10n ** (NATIVE_DECIMALS + BigInt(price.decimals))) /
      price.answer
    );
  }

  private async read(): Promise<NativePrice> {
    const { key, nativeSymbol, priceFeed } = this.evm.config;
    const [, answer, , updatedAt] = await this.evm.client.readContract({
      address: priceFeed.address,
      abi: priceFeedAbi,
      functionName: "latestRoundData",
    });
    const ageSec = Date.now() / 1000 - Number(updatedAt);
    if (answer <= 0n) {
      throw new Error(`[${key}] ${nativeSymbol}/USD feed returned ${answer}`);
    }
    if (ageSec > priceFeed.maxAgeSec) {
      throw new Error(
        `[${key}] ${nativeSymbol}/USD feed is stale (${Math.round(ageSec)}s old)`,
      );
    }
    const price = {
      answer,
      decimals: priceFeed.decimals,
      usd: Number(answer) / 10 ** priceFeed.decimals,
    };
    this.cached = { price, fetchedAt: Date.now() };
    return price;
  }
}
