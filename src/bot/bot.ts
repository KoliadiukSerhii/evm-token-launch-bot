import { formatEther, parseEther } from "viem";
import { CHAINS } from "../chains/registry.js";
import { type ChainKey, isChainKey } from "../chains/types.js";
import { env } from "../config/env.js";
import {
  escapeHtml,
  formatAmount,
  formatToken,
  formatUsd,
  toNumber,
} from "../core/format.js";
import { log } from "../core/logger.js";
import { parseTokenEntry } from "../core/token-spec.js";
import type { Pool } from "../domain/pool.js";
import { findOccupyingDeployment } from "../domain/deployment-guards.js";
import {
  type Deployment,
  isLive,
  type LiveDeployment,
  type TokenSpec,
} from "../domain/types.js";
import { DeployScheduler } from "../services/deploy-scheduler.js";
import { PoolLifetimeManager } from "../services/pool-lifetime.js";
import { reconcileStartup } from "../services/startup-reconcile.js";
import { describeTradeError } from "../services/token-trader.js";
import type { StateStore } from "../storage/state-store.js";
import type { TokenQueueStore } from "../storage/token-queue-store.js";
import { ChainRuntime } from "./chain-runtime.js";
import { chartLink, explorerLink, type Reporter } from "./reporter.js";

const LOW_NATIVE = parseEther("0.01");

export class Bot {
  private readonly runtimes = new Map<ChainKey, ChainRuntime>();
  private readonly schedulers = new Map<ChainKey, DeployScheduler>();
  private readonly lifetime: PoolLifetimeManager;
  private shuttingDown = false;

  constructor(
    private readonly store: StateStore,
    private readonly tokenQueue: TokenQueueStore,
    private readonly reporter: Reporter,
  ) {
    this.lifetime = new PoolLifetimeManager(
      store,
      env.poolLifetimeMs,
      async (deployment, reason) => {
        if (this.shuttingDown) return;
        const runtime = this.runtimes.get(deployment.chain);
        if (deployment.pair) runtime?.monitor.untrack(deployment.pair);
        this.reporter.poolWithdrawn(deployment, reason);
        await this.schedulers.get(deployment.chain)?.onCoinExited();
      },
      (chain, symbol, delayMs, error, attempt) => {
        this.reporter.exitCritical(
          [
            `[${chain}] exit attempt #${attempt} failed for ${symbol}`,
            `Retry in ${Math.round(delayMs / 1000)}s (exponential backoff)`,
            "5m deploy cooldown is NOT started until the position is closed",
            error,
          ].join("\n"),
        );
      },
      async (chain) => {
        await this.tokenQueue.clearNextDeployAt(chain);
      },
    );

    for (const key of env.chains) {
      const runtime = new ChainRuntime(
        CHAINS[key],
        env.rpcUrls[key]!,
        env.withdrawRpcUrls[key] ?? [],
        env.privateKey,
        env.poolUsd,
        store,
        reporter,
      );
      this.runtimes.set(key, runtime);
      this.lifetime.registerRuntime(key, runtime.remover);
      this.schedulers.set(
        key,
        new DeployScheduler(key, tokenQueue, store, (spec) =>
          this.launchInternal(runtime, spec),
        ),
      );
    }
  }

  get wallet(): string {
    return [...this.runtimes.values()][0]!.evm.address;
  }

  async start(): Promise<void> {
    await this.tokenQueue.syncFromEnv(env.chains, env.tokens);
    await Promise.all(
      [...this.runtimes.values()].map((runtime) => this.startChain(runtime)),
    );
  }

  stop(): void {
    this.shuttingDown = true;
    this.lifetime.stop();
    for (const scheduler of this.schedulers.values()) scheduler.stop();
    for (const runtime of this.runtimes.values()) runtime.monitor.stop();
  }

  set tradeAlerts(enabled: boolean) {
    this.reporter.tradeAlerts = enabled;
  }

  set exitDetailAlerts(enabled: boolean) {
    this.reporter.exitDetailAlerts = enabled;
  }

  async deploy(symbol?: string, chain?: string): Promise<string> {
    const keys = this.chainsFor(chain);
    const lines = await Promise.all(
      keys.map((key) => this.deployOn(key, symbol)),
    );
    return lines.join("\n");
  }

  async addToken(entry: string, chain?: string): Promise<string> {
    const spec = parseTokenEntry(entry);
    const keys = this.chainsFor(chain);
    const lines: string[] = [];
    for (const key of keys) {
      if (this.tokenQueue.hasDeployedSymbol(key, spec.symbol)) {
        lines.push(
          `❌ ${escapeHtml(spec.symbol)} was already deployed on ${key}`,
        );
        continue;
      }
      const moved = this.tokenQueue
        .queue(key)
        .some((token) => token.symbol === spec.symbol);
      await this.tokenQueue.prepend(key, spec);
      lines.push(
        moved
          ? `✅ <b>${escapeHtml(spec.symbol)}</b> moved to the front of the ${key} queue`
          : `✅ <b>${escapeHtml(spec.symbol)}</b> queued first on ${key}`,
      );
    }
    return lines.join("\n");
  }

  async setTokenOrder(raw: string, chain?: string): Promise<string> {
    const colon = raw.indexOf(":");
    if (colon <= 0) {
      return "Usage: /set_token_order &lt;SYMBOL&gt;:&lt;INDEX&gt; [chain]";
    }
    const symbol = raw.slice(0, colon).trim();
    const index = Number(raw.slice(colon + 1).trim());
    if (!Number.isInteger(index) || index < 0) {
      return "INDEX must be a non-negative integer";
    }
    const lines: string[] = [];
    for (const key of this.chainsFor(chain)) {
      try {
        await this.tokenQueue.reorder(key, symbol, index);
        lines.push(
          `✅ ${escapeHtml(symbol.toUpperCase())} is at index ${index} on ${key}`,
        );
      } catch (error) {
        lines.push(
          `❌ ${key}: ${escapeHtml(error instanceof Error ? error.message : String(error))}`,
        );
      }
    }
    return lines.join("\n");
  }

  async cancelTimer(symbol: string, chain?: string): Promise<string> {
    const key = chain === undefined ? undefined : this.chainsFor(chain)[0];
    const lines = await this.lifetime.cancelTimer(symbol, key);
    return lines.map((line) => `✅ ${escapeHtml(line)}`).join("\n");
  }

  async sellAll(symbol?: string, chain?: string): Promise<string> {
    const key = chain === undefined ? undefined : this.chainsFor(chain)[0];
    const result = this.lifetime.sellAll(symbol, key);
    if ("error" in result) return `❌ ${escapeHtml(result.error)}`;
    const name = CHAINS[result.chain].chain.name;
    return `✅ Selling all <b>${escapeHtml(result.symbol)}</b> on ${escapeHtml(name)}. Wallet tokens are swapped, LP is removed, and the native coin returns to the wallet.`;
  }

  async sellTokensInPercent(percent: number, chain?: string): Promise<string> {
    const key = this.requireChain(chain, "/sell_tokens_in_percent");
    const deployment = this.liveOn(key);
    const runtime = this.runtimes.get(key)!;
    if (percent >= 75) {
      let soldFirst = false;
      try {
        await runtime.trader.sellPercent(deployment, percent);
        soldFirst = true;
      } catch (error) {
        if (!this.noTokenBalance(error)) throw error;
      }
      const updated = await this.lifetime.forceExit(key, deployment.symbol);
      const config = CHAINS[key];
      const txs = (updated.exitTxHashes ?? [])
        .map((hash) => explorerLink(config, "tx", hash))
        .join(" · ");
      return [
        `✅ ${escapeHtml(deployment.symbol)} on ${key}: sold ${percent}% and closed the pool`,
        soldFirst ? "Wallet tokens were swapped, then LP was removed." : "Wallet had no tokens; LP was removed.",
        txs,
      ]
        .filter(Boolean)
        .join("\n");
    }
    const hash = await runtime.trader.sellPercent(deployment, percent).catch((error: unknown) => {
      if (this.noTokenBalance(error)) {
        throw new Error(
          `${describeTradeError(error)}. Wallet tokens are separate from the LP position; use 75–100 to close the pool, or wait for the timer`,
        );
      }
      throw error;
    });
    const config = CHAINS[key];
    return `✅ Sold ${percent}% of ${escapeHtml(deployment.symbol)} on ${key}\n${explorerLink(config, "tx", hash, "tx")}`;
  }

  async buyTokensInNative(amount: string, chain?: string): Promise<string> {
    if (!/^\d+(\.\d{1,18})?$/.test(amount)) {
      throw new Error("amount must look like 0.05 or 1");
    }
    const key = this.requireChain(chain, "/buy_tokens_in_sol");
    const deployment = this.liveOn(key);
    const runtime = this.runtimes.get(key)!;
    const hash = await runtime.trader.buyNative(deployment, parseEther(amount));
    const config = CHAINS[key];
    return `✅ Bought ${escapeHtml(deployment.symbol)} on ${key} for ${amount} ${config.nativeSymbol}\n${explorerLink(config, "tx", hash, "tx")}`;
  }

  async status(): Promise<string> {
    const sections = await Promise.all(
      [...this.runtimes.values()].map((runtime) => this.chainStatus(runtime)),
    );
    return sections.join("\n\n");
  }

  async balances(): Promise<string> {
    const lines = await Promise.all(
      [...this.runtimes.values()].map(async (runtime) => {
        const [balance, usd] = await Promise.all([
          runtime.evm.balance(),
          runtime.oracle.usd(),
        ]);
        const native = toNumber(balance);
        return `${escapeHtml(runtime.config.chain.name)}: ${formatAmount(native)} ${runtime.config.nativeSymbol} (${formatUsd(usd === null ? null : native * usd)})`;
      }),
    );
    return [`<b>Wallet</b> <code>${this.wallet}</code>`, ...lines].join("\n");
  }

  async health(): Promise<string> {
    const sections = await Promise.all(
      [...this.runtimes.values()].map((runtime) => this.chainHealth(runtime)),
    );
    return [
      "<b>Health</b>",
      `Trade alerts: ${this.reporter.tradeAlerts ? "on" : "off"}`,
      `Exit detail: ${this.reporter.exitDetailAlerts ? "on" : "off"}`,
      ...sections,
    ].join("\n\n");
  }

  private async startChain(runtime: ChainRuntime): Promise<void> {
    const scheduler = this.schedulers.get(runtime.key)!;
    await reconcileStartup(runtime.key, this.store, this.tokenQueue);
    await this.recoverPending(runtime, scheduler);
    await this.resume(runtime);
    await this.lifetime.bootstrap(runtime.key);
    await scheduler.bootstrap();
  }

  private async recoverPending(
    runtime: ChainRuntime,
    scheduler: DeployScheduler,
  ): Promise<void> {
    const pending = this.store
      .deployments(runtime.key)
      .filter((deployment) => deployment.status === "pending");
    for (const deployment of pending) {
      log.alert(
        `[${runtime.key}] recovering pending launch ${deployment.symbol}`,
      );
      await scheduler.enqueue(() =>
        this.launchInternal(runtime, {
          name: deployment.name,
          symbol: deployment.symbol,
          supply: BigInt(deployment.supply),
        }),
      );
    }
  }

  private async resume(runtime: ChainRuntime): Promise<void> {
    for (const deployment of this.store.deployments(runtime.key)) {
      if (!isLive(deployment)) continue;
      await runtime.monitor.track(deployment, true).catch((error) => {
        log.alertError(
          `[${runtime.key}] cannot monitor ${deployment.symbol}`,
          error,
        );
      });
    }
  }

  private async deployOn(chain: ChainKey, symbol?: string): Promise<string> {
    const scheduler = this.schedulers.get(chain)!;
    let spec: TokenSpec | undefined;
    if (symbol?.trim()) {
      spec = this.tokenQueue
        .queue(chain)
        .find((token) => token.symbol === symbol.toUpperCase());
      if (!spec) {
        const listed = this.tokenQueue
          .queue(chain)
          .map((token) => token.symbol)
          .join(", ");
        return `❌ ${chain}: token ${escapeHtml(symbol)} is not queued${listed ? ` (${escapeHtml(listed)})` : ""}`;
      }
    } else {
      spec = this.tokenQueue.nextDeployable(chain);
      if (!spec) {
        return `❌ ${chain}: queue empty or every symbol was already deployed`;
      }
    }
    const block = await scheduler.requestDeploy(spec);
    return block
      ? `❌ ${escapeHtml(block)}`
      : `✅ ${escapeHtml(spec.symbol)} deployed on ${chain}`;
  }

  private async launchInternal(
    runtime: ChainRuntime,
    spec: TokenSpec,
  ): Promise<boolean> {
    const occupying = findOccupyingDeployment(
      this.store.deployments(runtime.key),
      runtime.key,
    );
    if (occupying && occupying.symbol !== spec.symbol) {
      log.warn(
        `[${runtime.key}] skip launch ${spec.symbol}: ${occupying.symbol} is ${occupying.status}`,
      );
      return false;
    }
    const existing = this.store.get(runtime.key, spec.symbol);
    try {
      if (existing && isLive(existing)) {
        await runtime.monitor.track(existing);
        await this.tokenQueue.recordDeployed(
          runtime.key,
          existing.symbol,
          existing.token,
        );
        await this.tokenQueue.clearNextDeployAt(runtime.key);
        return true;
      }
      let deployment;
      if (existing?.status === "pending") {
        this.reporter.recovered(existing);
        deployment = await runtime.launcher.recover(existing);
      } else {
        this.reporter.launching(runtime.config, spec, env.poolUsd);
        deployment = await runtime.launcher.launch(spec);
      }
      this.reporter.launched(deployment, env.poolLifetimeMs);
      await runtime.monitor.track(deployment);
      await this.lifetime.onLaunched(deployment);
      await this.tokenQueue.recordDeployed(
        runtime.key,
        deployment.symbol,
        deployment.token,
      );
      await this.tokenQueue.clearNextDeployAt(runtime.key);
      return true;
    } catch (error) {
      log.alertError(`[${runtime.key}] launch of ${spec.symbol} failed`, error);
      return false;
    }
  }

  private async chainStatus(runtime: ChainRuntime): Promise<string> {
    const { config } = runtime;
    const nativeUsd = await runtime.oracle.usd();
    const lines = [
      `<b>${escapeHtml(config.chain.name)}</b> · ${config.dex.name} · ${config.nativeSymbol} ${formatUsd(nativeUsd)}`,
    ];
    const active = this.tokenQueue.activeSymbol(runtime.key);
    if (active) lines.push(`Active: <b>${escapeHtml(active)}</b>`);
    const nextAt = this.tokenQueue.nextDeployAt(runtime.key);
    if (nextAt && Date.parse(nextAt) > Date.now()) {
      const sec = Math.ceil((Date.parse(nextAt) - Date.now()) / 1000);
      lines.push(`Next deploy cooldown: ${sec}s`);
    }
    const next = this.tokenQueue.nextDeployable(runtime.key);
    if (next) lines.push(`Next in queue: <b>${escapeHtml(next.symbol)}</b>`);
    const queue = this.tokenQueue.queue(runtime.key);
    if (queue.length > 0) {
      lines.push(
        `Queue: ${queue.map((token, index) => `${index}:${token.symbol}`).join(", ")}`,
      );
    }

    const pools = new Map(
      runtime.monitor.list().map((pool) => [pool.deployment.symbol, pool]),
    );
    const deployments = this.store.deployments(runtime.key);
    const known = new Set(deployments.map((deployment) => deployment.symbol));
    for (const deployment of deployments) {
      const pool = pools.get(deployment.symbol);
      lines.push(
        pool
          ? this.poolStatus(pool, nativeUsd)
          : this.deploymentStatus(deployment),
      );
    }
    for (const spec of queue) {
      if (!known.has(spec.symbol)) {
        lines.push(`<b>${escapeHtml(spec.symbol)}</b>: queued, not deployed`);
      }
    }
    return lines.join("\n");
  }

  private async chainHealth(runtime: ChainRuntime): Promise<string> {
    const started = Date.now();
    let rpc = "error";
    try {
      await runtime.evm.client.getBlockNumber();
      rpc = `${Date.now() - started}ms`;
    } catch {
      rpc = "error";
    }
    const balance = await runtime.evm.balance().catch(() => null);
    const occupying = findOccupyingDeployment(
      this.store.deployments(runtime.key),
      runtime.key,
    );
    const nextAt = this.tokenQueue.nextDeployAt(runtime.key);
    const cooldown =
      nextAt && Date.parse(nextAt) > Date.now()
        ? `${Math.ceil((Date.parse(nextAt) - Date.now()) / 1000)}s`
        : "none";
    const low =
      balance !== null && balance < LOW_NATIVE ? " (low — fund before deploy)" : "";
    return [
      `<b>${escapeHtml(runtime.config.chain.name)}</b>`,
      `RPC: ${rpc}`,
      `Balance: ${balance === null ? "error" : `${formatEther(balance)} ${runtime.config.nativeSymbol}`}${low}`,
      `Slot: ${occupying ? `${occupying.symbol} (${occupying.status})` : "free"}`,
      occupying && isLive(occupying) && occupying.error
        ? `Exit: retrying (${escapeHtml(occupying.error)})`
        : "Exit: ok",
      `Queue: ${this.tokenQueue.queue(runtime.key).length} · next: ${this.tokenQueue.nextDeployable(runtime.key)?.symbol ?? "none"}`,
      `Cooldown: ${cooldown}`,
    ].join("\n");
  }

  private poolStatus(pool: Pool, nativeUsd: number | null): string {
    const { deployment } = pool;
    const config = CHAINS[deployment.chain];
    const toUsd = (native: number): number | null =>
      nativeUsd === null ? null : native * nativeUsd;
    const priceNative = pool.priceNative();
    const priceUsd = priceNative === null ? null : toUsd(priceNative);
    const reserveNative = toNumber(pool.reserveNative);
    const volumeNative = toNumber(pool.boughtNative + pool.soldNative);
    return [
      `<b>${escapeHtml(deployment.symbol)}</b> · ${escapeHtml(deployment.name)}`,
      this.lifetimeLine(deployment),
      `Price: ${formatUsd(priceUsd)} · MC: ${formatUsd(priceUsd === null ? null : priceUsd * pool.supply)}`,
      `Liquidity: ${formatUsd(toUsd(reserveNative * 2))} (${formatAmount(reserveNative)} ${config.nativeSymbol} + ${formatToken(pool.reserveToken)} ${escapeHtml(deployment.symbol)})`,
      `Since start: buys ${pool.buys} · sells ${pool.sells} · volume ${formatAmount(volumeNative)} ${config.nativeSymbol} (${formatUsd(toUsd(volumeNative))})`,
      `${explorerLink(config, "address", deployment.token, "Token")} · ${explorerLink(config, "address", deployment.pair, "Pair")} · ${chartLink(config, deployment.pair)}`,
    ].join("\n");
  }

  private deploymentStatus(deployment: Deployment): string {
    const config = CHAINS[deployment.chain];
    const detail = deployment.error ? `: ${escapeHtml(deployment.error)}` : "";
    if (deployment.status === "withdrawn") {
      const tx = deployment.withdrawTxHash
        ? explorerLink(config, "tx", deployment.withdrawTxHash, "exit tx")
        : "";
      return `<b>${escapeHtml(deployment.symbol)}</b>: exited${tx ? ` · ${tx}` : ""}`;
    }
    const timer = this.lifetimeLine(deployment);
    return `<b>${escapeHtml(deployment.symbol)}</b>: ${deployment.status}${detail}${timer ? `\n${timer}` : ""} · ${explorerLink(config, "tx", deployment.txHash, "tx")} · ${formatEther(BigInt(deployment.poolNative))} ${config.nativeSymbol}`;
  }

  private lifetimeLine(deployment: Deployment): string {
    if (deployment.status !== "live") return "";
    if (deployment.poolLifetimeDisabled) {
      return "Auto shutdown: off (/canceltimer)";
    }
    if (!deployment.poolExpiresAt) return "Auto shutdown: pending…";
    const leftMs = Date.parse(deployment.poolExpiresAt) - Date.now();
    if (leftMs <= 0) return "Auto shutdown: due now";
    const hours = Math.floor(leftMs / 3_600_000);
    const mins = Math.floor((leftMs % 3_600_000) / 60_000);
    return `Auto shutdown: in ${hours}h ${mins}m (/canceltimer to cancel)`;
  }

  private liveOn(chain: ChainKey): LiveDeployment {
    const live = this.store.deployments(chain).filter(isLive);
    if (live.length !== 1) {
      throw new Error(
        live.length === 0
          ? `no live token on ${chain}`
          : `multiple live tokens on ${chain}`,
      );
    }
    return live[0]!;
  }

  private chainsFor(raw?: string): ChainKey[] {
    if (!raw) return [...this.runtimes.keys()];
    const key = raw.toLowerCase();
    if (!isChainKey(key) || !this.runtimes.has(key)) {
      throw new Error(
        `chain ${raw} is not in CHAINS (${env.chains.join(", ")})`,
      );
    }
    return [key];
  }

  private requireChain(raw: string | undefined, command: string): ChainKey {
    if (!raw) {
      if (this.runtimes.size === 1) return [...this.runtimes.keys()][0]!;
      throw new Error(`${command} needs a chain: ${env.chains.join(", ")}`);
    }
    return this.chainsFor(raw)[0]!;
  }

  private noTokenBalance(error: unknown): boolean {
    const message = describeTradeError(error);
    return message.includes("no ") && message.includes("balance to sell");
  }
}
