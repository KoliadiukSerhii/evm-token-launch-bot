import { log } from "../core/logger.js";
import { scheduleAt, type ScheduledHandle } from "../core/time.js";
import type { ChainKey } from "../chains/types.js";
import {
  type Deployment,
  isLive,
  type LiveDeployment,
} from "../domain/types.js";
import type { StateStore } from "../storage/state-store.js";
import { takeRetryDelay } from "./exit-retry.js";
import type { LiquidityRemover } from "./liquidity-remover.js";
import { describeLiquidityError } from "./liquidity-remover.js";

export type ExitReason = "timer" | "startup" | "sell" | "manual";

export type PoolWithdrawnHandler = (
  deployment: Deployment,
  reason: ExitReason,
) => void | Promise<void>;

export type ExitRetryHandler = (
  chain: ChainKey,
  symbol: string,
  delayMs: number,
  error: string,
  attempt: number,
) => void;

interface RuntimeRef {
  key: ChainKey;
  remover: LiquidityRemover;
}

export class PoolLifetimeManager {
  private readonly timers = new Map<string, ScheduledHandle>();
  private readonly retryDelayMs = new Map<string, number>();
  private readonly retryAttempt = new Map<string, number>();
  private readonly exitOptions = new Map<
    string,
    { sellWalletFirst?: boolean }
  >();
  private readonly exiting = new Set<string>();
  private readonly runtimes = new Map<ChainKey, RuntimeRef>();

  constructor(
    private readonly store: StateStore,
    private readonly lifetimeMs: number,
    private readonly onWithdrawn: PoolWithdrawnHandler,
    private readonly onExitRetry: ExitRetryHandler = () => {},
    private readonly onExitFailed: (chain: ChainKey) => void | Promise<void> = () => {},
  ) {}

  registerRuntime(key: ChainKey, remover: LiquidityRemover): void {
    this.runtimes.set(key, { key, remover });
  }

  stop(): void {
    for (const timer of this.timers.values()) timer.cancel();
    this.timers.clear();
  }

  async bootstrap(chain: ChainKey): Promise<void> {
    for (const deployment of this.store.deployments(chain)) {
      if (!isLive(deployment)) continue;
      await this.schedule(deployment);
    }
  }

  async onLaunched(deployment: LiveDeployment): Promise<void> {
    this.clearRetryState(deployment);
    await this.schedule(deployment);
  }

  async cancelTimer(symbol: string, chain?: ChainKey): Promise<string[]> {
    const upper = symbol.toUpperCase();
    const chains = chain ? [chain] : ([...this.runtimes.keys()] as ChainKey[]);
    const messages: string[] = [];

    for (const key of chains) {
      const deployment = this.store.get(key, upper);
      if (!deployment || !isLive(deployment)) {
        messages.push(`${upper} is not live on ${key}`);
        continue;
      }
      if (deployment.poolLifetimeDisabled) {
        messages.push(`${upper} on ${key}: timer already off`);
        continue;
      }
      this.clearTimer(deployment);
      await this.store.upsert({
        ...deployment,
        poolLifetimeDisabled: true,
        poolExpiresAt: undefined,
      });
      messages.push(`${upper} on ${key}: auto shutdown timer cancelled`);
    }
    return messages;
  }

  /**
   * Sell the whole position: wallet tokens, then LP, then tokens that come
   * back from the pool. Same drain as the timer. Returns once the drain has
   * started.
   */
  sellAll(
    symbol?: string,
    chain?: ChainKey,
  ): { chain: ChainKey; symbol: string } | { error: string } {
    const requested = symbol?.trim().toUpperCase();
    const chains = chain ? [chain] : ([...this.runtimes.keys()] as ChainKey[]);
    const live = chains.flatMap((key) =>
      this.store.deployments(key).filter(isLive),
    );
    const matches = requested
      ? live.filter((coin) => coin.symbol === requested)
      : live;
    const deployment = matches.length === 1 ? matches[0] : undefined;
    if (!deployment) {
      if (matches.length === 0) {
        if (requested && chain) {
          return { error: `${requested} is not live on ${chain}` };
        }
        if (requested) return { error: `${requested} is not live` };
        if (chain) return { error: `no live token on ${chain}` };
        return { error: "no live token — deploy first" };
      }
      if (requested) {
        const where = matches.map((coin) => coin.chain).join(", ");
        return {
          error: `${requested} is live on ${where}; use /sell_all ${requested} CHAIN`,
        };
      }
      const names = matches
        .map((coin) => `${coin.symbol} on ${coin.chain}`)
        .join(", ");
      return {
        error: `multiple live tokens (${names}); use /sell_all SYMBOL [chain]`,
      };
    }
    const key = this.timerKey(deployment);
    if (this.exiting.has(key)) {
      return { error: `${deployment.symbol} on ${deployment.chain} is already selling` };
    }
    this.exitOptions.set(key, { sellWalletFirst: true });
    void this.withdraw(deployment.chain, deployment.symbol, "manual");
    return { chain: deployment.chain, symbol: deployment.symbol };
  }

  /** Manual exit (sell from 75%). Keeps the unsold wallet remainder. */
  async forceExit(chain: ChainKey, symbol: string): Promise<Deployment> {
    const fresh = this.store.get(chain, symbol);
    if (!fresh || !isLive(fresh)) {
      throw new Error(`${symbol} is not live on ${chain}`);
    }
    const key = this.timerKey(fresh);
    if (this.exiting.has(key)) {
      throw new Error(`${symbol} on ${chain} is already selling`);
    }
    this.exiting.add(key);
    this.exitOptions.set(key, { sellWalletFirst: false });
    this.clearTimer(fresh);
    try {
      const updated = await this.withdrawOnce(fresh, { sellWalletFirst: false });
      this.clearRetryState(fresh);
      await this.onWithdrawn(updated, "sell");
      return updated;
    } catch (error) {
      await this.scheduleRetry(fresh, error, "timer");
      throw error;
    } finally {
      this.exiting.delete(key);
    }
  }

  private timerKey(deployment: Deployment): string {
    return `${deployment.chain}:${deployment.symbol}`;
  }

  private clearTimer(deployment: Deployment): void {
    const key = this.timerKey(deployment);
    this.timers.get(key)?.cancel();
    this.timers.delete(key);
  }

  private clearRetryState(deployment: Deployment): void {
    const key = this.timerKey(deployment);
    this.retryDelayMs.delete(key);
    this.retryAttempt.delete(key);
    this.exitOptions.delete(key);
  }

  private async schedule(
    deployment: LiveDeployment,
    source: "launch" | "startup" = "launch",
  ): Promise<void> {
    if (deployment.poolLifetimeDisabled) return;
    this.clearTimer(deployment);

    let expiresAt = deployment.poolExpiresAt
      ? Date.parse(deployment.poolExpiresAt)
      : NaN;
    if (!Number.isFinite(expiresAt)) {
      expiresAt = Date.parse(deployment.createdAt) + this.lifetimeMs;
      await this.store.upsert({
        ...deployment,
        poolExpiresAt: new Date(expiresAt).toISOString(),
      });
    }

    if (expiresAt - Date.now() <= 0) {
      log.info(
        `[${deployment.chain}] pool lifetime expired for ${deployment.symbol}, withdrawing`,
        { source },
      );
      await this.withdraw(deployment.chain, deployment.symbol, "startup");
      return;
    }

    log.info(
      `[${deployment.chain}] pool lifetime timer set for ${deployment.symbol}`,
      { expiresAt: new Date(expiresAt).toISOString() },
    );
    this.timers.set(
      this.timerKey(deployment),
      scheduleAt(expiresAt, () => {
        void this.withdraw(deployment.chain, deployment.symbol, "timer");
      }),
    );
  }

  private async withdraw(
    chain: ChainKey,
    symbol: string,
    reason: Exclude<ExitReason, "sell">,
  ): Promise<void> {
    const fresh = this.store.get(chain, symbol);
    if (!fresh || !isLive(fresh)) return;
    const key = this.timerKey(fresh);
    if (this.exiting.has(key)) return;
    this.exiting.add(key);
    this.clearTimer(fresh);
    try {
      const updated = await this.withdrawOnce(fresh, this.exitOptions.get(key));
      this.clearRetryState(fresh);
      await this.onWithdrawn(updated, reason);
    } catch (error) {
      await this.scheduleRetry(fresh, error, reason);
    } finally {
      this.exiting.delete(key);
    }
  }

  private async withdrawOnce(
    deployment: LiveDeployment,
    options: { sellWalletFirst?: boolean } = {},
  ): Promise<Deployment> {
    const runtime = this.runtimes.get(deployment.chain);
    if (!runtime) {
      throw new Error(`runtime missing for ${deployment.chain}`);
    }
    const fresh = this.store.get(deployment.chain, deployment.symbol);
    if (!fresh || !isLive(fresh)) {
      throw new Error(`${deployment.symbol} is not live on ${deployment.chain}`);
    }
    return runtime.remover.withdraw(fresh, options);
  }

  private async scheduleRetry(
    deployment: LiveDeployment,
    error: unknown,
    reason: Exclude<ExitReason, "sell">,
  ): Promise<void> {
    log.alertError(
      `[${deployment.chain}] auto withdraw failed for ${deployment.symbol}`,
      error,
    );
    const fresh = this.store.get(deployment.chain, deployment.symbol);
    if (!fresh || !isLive(fresh)) return;
    const key = this.timerKey(fresh);
    const { wait, next } = takeRetryDelay(this.retryDelayMs.get(key));
    this.retryDelayMs.set(key, next);
    const attempt = (this.retryAttempt.get(key) ?? 0) + 1;
    this.retryAttempt.set(key, attempt);
    const message = describeLiquidityError(error);
    await this.store.upsert({ ...fresh, error: message });
    await this.onExitFailed(fresh.chain);
    this.onExitRetry(fresh.chain, fresh.symbol, wait, message, attempt);
    this.timers.set(
      key,
      scheduleAt(Date.now() + wait, () => {
        void this.withdraw(fresh.chain, fresh.symbol, reason);
      }),
    );
  }
}
