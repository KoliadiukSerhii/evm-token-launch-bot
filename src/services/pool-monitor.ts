import type { Address, GetLogsReturnType, Hex } from "viem";
import { pairEventsAbi, pairReadAbi } from "../abi/index.js";
import type { ChainKey } from "../chains/types.js";
import { describeError } from "../core/errors.js";
import { toNumber } from "../core/format.js";
import { log } from "../core/logger.js";
import { Pool } from "../domain/pool.js";
import type { LiveDeployment, PoolEvent } from "../domain/types.js";
import type { EvmClient } from "../evm/evm-client.js";
import type { StateStore } from "../storage/state-store.js";
import type { NativePriceOracle } from "./price-oracle.js";

type PairLog = GetLogsReturnType<undefined, typeof pairEventsAbi, true>[number];

export type PoolEventListener = (event: PoolEvent, historical: boolean) => void;

interface Backfill {
  pair: Address;
  from: bigint;
  to: bigint;
}

const MIN_STALL_MS = 30_000;
const HISTORICAL_LAG_MS = 60_000;
/** HTTP fallback only. A websocket subscription ignores this. */
const MONITOR_POLL_MS = 30_000;
/** 5s, 15s, 30s, then every 60s. New blocks do not punch through this wait. */
const MONITOR_RETRY_STEPS_MS = [5_000, 15_000, 30_000, 60_000];

export function monitorRetryDelayMs(attempt: number): number {
  const index = Math.min(
    Math.max(attempt, 1),
    MONITOR_RETRY_STEPS_MS.length,
  ) - 1;
  return MONITOR_RETRY_STEPS_MS[index]!;
}

export class PoolMonitor {
  private readonly pools = new Map<string, Pool>();
  private readonly backfills: Backfill[] = [];
  private cursor: bigint | null = null;
  private head = 0n;
  private range: bigint;
  private draining = false;
  private failures = 0;
  /** Ignore new heads until this time. Stops a failed read from retrying every block. */
  private retryAfter = 0;
  private lastHeadAt = 0;
  private unwatch: (() => void) | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly evm: EvmClient,
    private readonly oracle: NativePriceOracle,
    private readonly store: StateStore,
    private readonly listener: PoolEventListener,
  ) {
    this.range = evm.config.maxLogRange;
  }

  get chain(): ChainKey {
    return this.evm.config.key;
  }

  list(): Pool[] {
    return [...this.pools.values()];
  }

  async track(deployment: LiveDeployment, restored = false): Promise<void> {
    const key = deployment.pair.toLowerCase();
    if (this.pools.has(key)) return;

    const pool = new Pool(deployment);
    const [reserve0, reserve1] = await this.evm.client.readContract({
      address: deployment.pair,
      abi: pairReadAbi,
      functionName: "getReserves",
    });
    pool.sync(reserve0, reserve1);
    this.pools.set(key, pool);

    const block = BigInt(deployment.block);
    this.cursor ??= this.store.cursor(this.chain) ?? block - 1n;
    if (!restored && this.cursor >= block) {
      this.backfills.push({
        pair: deployment.pair,
        from: block,
        to: this.cursor,
      });
    }

    log.info(`[${this.chain}] monitoring ${deployment.symbol}`, {
      pair: deployment.pair,
      fromBlock: block,
    });
    this.subscribe();
    void this.drain();
  }

  untrack(pair: Address): void {
    this.pools.delete(pair.toLowerCase());
  }

  stop(): void {
    this.unwatch?.();
    this.unwatch = null;
    for (const timer of [this.watchdog, this.retryTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.watchdog = null;
    this.retryTimer = null;
    this.retryAfter = 0;
  }

  private subscribe(): void {
    if (this.unwatch) return;
    this.lastHeadAt = Date.now();
    this.unwatch = this.evm.client.watchBlockNumber({
      emitOnBegin: true,
      pollingInterval: MONITOR_POLL_MS,
      onBlockNumber: (block) => this.onHead(block),
      onError: (error) =>
        log.warn(`[${this.chain}] block subscription error`, {
          error: describeError(error),
        }),
    });

    const stallMs = Math.max(
      MONITOR_POLL_MS * 3,
      MIN_STALL_MS,
      this.evm.config.blockTimeMs * 10,
    );
    this.watchdog ??= setInterval(() => {
      if (Date.now() - this.lastHeadAt < stallMs) return;
      log.warn(
        `[${this.chain}] no new blocks for ${stallMs / 1000}s, resubscribing`,
      );
      this.unwatch?.();
      this.unwatch = null;
      this.subscribe();
      this.evm.client
        .getBlockNumber({ cacheTime: 0 })
        .then((block) => this.onHead(block))
        .catch(() => undefined);
    }, stallMs);
  }

  private onHead(block: bigint): void {
    this.lastHeadAt = Date.now();
    if (block > this.head) this.head = block;
    if (Date.now() < this.retryAfter) return;
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining || this.cursor === null) return;
    this.draining = true;
    try {
      while (this.backfills.length > 0) {
        const job = this.backfills[0]!;
        const { logs, to } = await this.fetch([job.pair], job.from, job.to);
        await this.handle(logs, true);
        job.from = to + 1n;
        if (job.from > job.to) this.backfills.shift();
      }
      while (this.cursor < this.head) {
        const { logs, to } = await this.fetch(
          this.list().map((pool) => pool.pair),
          this.cursor + 1n,
          this.head,
        );
        await this.handle(logs, this.isHistorical(to));
        this.cursor = to;
        this.store.setCursor(this.chain, to);
      }
      if (this.failures > 0) {
        log.alert(
          `[${this.chain}] monitor recovered after ${this.failures} failed attempts`,
        );
        this.failures = 0;
      }
    } catch (error) {
      this.failures++;
      const delay = monitorRetryDelayMs(this.failures);
      this.retryAfter = Date.now() + delay;
      if (this.failures === 1) {
        log.alertError(
          `[${this.chain}] monitor failed, retrying in ${delay / 1000}s`,
          error,
        );
      } else {
        log.warn(`[${this.chain}] monitor retry ${this.failures} failed`, {
          error: describeError(error),
          retryInSec: delay / 1000,
        });
      }
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.retryAfter = 0;
        void this.drain();
      }, delay);
    } finally {
      this.draining = false;
    }
  }

  private async fetch(
    pairs: Address[],
    from: bigint,
    limit: bigint,
  ): Promise<{ logs: PairLog[]; to: bigint }> {
    for (;;) {
      const to =
        from + this.range - 1n < limit ? from + this.range - 1n : limit;
      try {
        const logs = await this.evm.client.getLogs({
          address: pairs,
          events: pairEventsAbi,
          fromBlock: from,
          toBlock: to,
          strict: true,
        });
        const grown = this.range * 2n;
        const max = this.evm.config.maxLogRange;
        this.range = grown < max ? grown : max;
        return { logs, to };
      } catch (error) {
        const message = describeError(error).toLowerCase();
        const transport =
          message.includes("rpc request failed") ||
          message.includes("limit") ||
          message.includes("429") ||
          message.includes("timeout") ||
          message.includes("fetch failed");
        if (transport || this.range === 1n) throw error;
        this.range /= 2n;
      }
    }
  }

  private isHistorical(block: bigint): boolean {
    const lagBlocks = BigInt(
      Math.ceil(HISTORICAL_LAG_MS / this.evm.config.blockTimeMs),
    );
    return this.head - block > lagBlocks;
  }

  private async handle(logs: PairLog[], historical: boolean): Promise<void> {
    if (logs.length === 0) return;
    const hashes = [
      ...new Set(
        logs
          .filter((entry) => entry.eventName !== "Sync")
          .map((entry) => entry.transactionHash),
      ),
    ];
    const [senders, nativeUsd] = await Promise.all([
      this.senders(hashes),
      this.oracle.usd(),
    ]);
    const usd = (native: bigint): number | null =>
      nativeUsd === null ? null : toNumber(native) * nativeUsd;

    for (const entry of logs) {
      const pool = this.pools.get(entry.address.toLowerCase());
      if (!pool) continue;
      const base = {
        deployment: pool.deployment,
        txHash: entry.transactionHash,
        block: entry.blockNumber,
      };

      switch (entry.eventName) {
        case "Sync":
          pool.sync(entry.args.reserve0, entry.args.reserve1);
          break;
        case "Swap": {
          const trade = pool.swap(entry.args);
          if (!trade) break;
          const priceNative =
            toNumber(trade.nativeAmount) / toNumber(trade.tokenAmount);
          const spotNative = pool.priceNative();
          this.listener(
            {
              kind: "trade",
              ...base,
              ...trade,
              trader: senders.get(entry.transactionHash) ?? entry.args.to,
              usd: usd(trade.nativeAmount),
              priceUsd: nativeUsd === null ? null : priceNative * nativeUsd,
              marketCapUsd:
                nativeUsd === null || spotNative === null
                  ? null
                  : spotNative * nativeUsd * pool.supply,
            },
            historical,
          );
          break;
        }
        case "Mint":
        case "Burn": {
          if (entry.transactionHash === pool.deployment.txHash) break;
          const amounts = pool.amounts(entry.args.amount0, entry.args.amount1);
          this.listener(
            {
              kind: "liquidity",
              action: entry.eventName === "Mint" ? "added" : "removed",
              ...base,
              ...amounts,
              provider: senders.get(entry.transactionHash) ?? entry.args.sender,
              usd: usd(amounts.nativeAmount * 2n),
            },
            historical,
          );
          break;
        }
      }
    }
  }

  private async senders(hashes: Hex[]): Promise<Map<Hex, Address>> {
    const entries = await Promise.all(
      hashes.map((hash) =>
        this.evm.client
          .getTransaction({ hash })
          .then((tx) => [hash, tx.from] as const)
          .catch(() => null),
      ),
    );
    return new Map(entries.filter((entry) => entry !== null));
  }
}
