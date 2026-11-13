import { formatEther } from "viem";
import { CHAINS } from "../chains/registry.js";
import { env } from "../config/env.js";
import type { ChainConfig } from "../chains/types.js";
import {
  escapeHtml,
  formatDurationMs,
  formatToken,
  formatUsd,
  shortAddress,
} from "../core/format.js";
import { log } from "../core/logger.js";
import type {
  Deployment,
  LiquidityEvent,
  LiveDeployment,
  PoolEvent,
  TokenSpec,
  TradeEvent,
} from "../domain/types.js";
import type { Telegram } from "../telegram/telegram.js";

export function explorerLink(
  config: ChainConfig,
  kind: "tx" | "address",
  value: string,
  label = shortAddress(value),
): string {
  const url = config.chain.blockExplorers?.default.url;
  return url ? `<a href="${url}/${kind}/${value}">${label}</a>` : label;
}

export function chartLink(config: ChainConfig, pair: string): string {
  return `<a href="https://dexscreener.com/${config.dexscreenerSlug}/${pair}">DexScreener</a>`;
}

export class Reporter {
  tradeAlerts = true;
  /** Verbose exit steps. Failures and the final exit message stay on. */
  exitDetailAlerts = false;

  constructor(private readonly telegram: Telegram) {}

  launching(config: ChainConfig, spec: TokenSpec, poolUsd: number): void {
    log.alert(
      `[${config.key}] launching ${spec.symbol} on ${config.dex.name} with $${poolUsd} pool`,
    );
  }

  launched(deployment: LiveDeployment, poolLifetimeMs: number): void {
    const config = CHAINS[deployment.chain];
    log.info(`[${deployment.chain}] ${deployment.symbol} launched`, deployment);
    this.telegram.send(
      [
        `🚀 <b>${escapeHtml(deployment.symbol)}</b> launched`,
        `Chain: ${escapeHtml(config.chain.name)}`,
        `Pool: ${formatToken(BigInt(deployment.poolNative))} ${config.nativeSymbol} ($${deployment.poolUsd})`,
        `Supply: ${formatToken(BigInt(deployment.supply), 0)} ${escapeHtml(deployment.symbol)}`,
        `Auto shutdown: ${formatDurationMs(poolLifetimeMs)}`,
        "Cancel: /canceltimer",
        `Token: ${explorerLink(config, "address", deployment.token, deployment.token)}`,
        `Pair: ${explorerLink(config, "address", deployment.pair, deployment.pair)}`,
        `Chart: ${chartLink(config, deployment.pair)}`,
        `Tx: ${explorerLink(config, "tx", deployment.txHash, deployment.txHash)}`,
        `Block: ${deployment.block}`,
      ].join("\n"),
    );
  }

  poolWithdrawn(
    deployment: Deployment,
    reason: "timer" | "startup" | "sell" | "manual",
  ): void {
    const config = CHAINS[deployment.chain];
    const why =
      reason === "manual"
        ? "/sell_all"
        : reason === "timer"
          ? "pool lifetime expired"
          : reason === "sell"
            ? "manual sell from 75% closed the pool"
            : "pool lifetime was overdue";
    log.info(
      `[${deployment.chain}] ${deployment.symbol} liquidity withdrawn (${why})`,
      { txHash: deployment.withdrawTxHash },
    );
    const hashes = deployment.exitTxHashes ?? [];
    const txLines =
      hashes.length > 0
        ? hashes.map(
            (hash, index) =>
              `Tx ${index + 1}: ${explorerLink(config, "tx", hash, hash)}`,
          )
        : deployment.withdrawTxHash
          ? [`Tx: ${explorerLink(config, "tx", deployment.withdrawTxHash, deployment.withdrawTxHash)}`]
          : [];
    this.telegram.send(
      [
        `🏁 <b>${escapeHtml(deployment.symbol)}</b> pool closed`,
        `Chain: ${escapeHtml(config.chain.name)}`,
        `Reason: ${escapeHtml(why)}`,
        "LP removed",
        "Tokens swapped to native where the pool still had liquidity",
        ...txLines,
        `Next deploy: ${formatDurationMs(env.deployCooldownMs)} cooldown`,
      ].join("\n"),
    );
  }

  exitCritical(line: string): void {
    log.error(line);
    this.telegram.send(`🚨 ${escapeHtml(line)}`);
  }

  exitDetail(line: string): void {
    log.info(line);
    if (this.exitDetailAlerts) this.telegram.send(`⏱ ${escapeHtml(line)}`);
  }

  recovered(deployment: Deployment): void {
    log.info(
      `[${deployment.chain}] resuming pending launch of ${deployment.symbol}`,
      {
        txHash: deployment.txHash,
      },
    );
  }

  event(event: PoolEvent, historical: boolean): void {
    if (event.kind === "trade") this.trade(event, historical);
    else this.liquidity(event, historical);
  }

  private trade(event: TradeEvent, historical: boolean): void {
    const config = CHAINS[event.deployment.chain];
    const { symbol } = event.deployment;
    const tokens = formatToken(event.tokenAmount);
    const native = formatEther(event.nativeAmount);

    log.info(
      `[${config.key}] ${event.side.toUpperCase()} ${tokens} ${symbol} for ${native} ${config.nativeSymbol} (${formatUsd(event.usd)}) by ${event.trader}`,
      {
        txHash: event.txHash,
        block: event.block,
        priceUsd: event.priceUsd,
        marketCapUsd: event.marketCapUsd,
        historical,
      },
    );
    if (historical || !this.tradeAlerts) return;

    const icon = event.side === "buy" ? "🟢 BUY" : "🔴 SELL";
    this.telegram.send(
      [
        `${icon} <b>${escapeHtml(symbol)}</b>`,
        `Chain: ${escapeHtml(config.chain.name)}`,
        `Wallet: ${explorerLink(config, "address", event.trader, event.trader)}`,
        `Tx: ${explorerLink(config, "tx", event.txHash, event.txHash)}`,
        `Tokens: ${tokens} ${escapeHtml(symbol)}`,
        `Native: ${formatToken(event.nativeAmount)} ${config.nativeSymbol} (${formatUsd(event.usd)})`,
        `Price: ${formatUsd(event.priceUsd)}`,
        `Market cap: ${formatUsd(event.marketCapUsd)}`,
      ].join("\n"),
    );
  }

  private liquidity(event: LiquidityEvent, historical: boolean): void {
    const config = CHAINS[event.deployment.chain];
    const { symbol } = event.deployment;
    const verb = event.action === "added" ? "added to" : "removed from";

    log.info(
      `[${config.key}] liquidity ${verb} ${symbol} pool: ${formatToken(event.tokenAmount)} ${symbol} + ${formatEther(event.nativeAmount)} ${config.nativeSymbol} (${formatUsd(event.usd)}) by ${event.provider}`,
      { txHash: event.txHash, block: event.block, historical },
    );
    if (historical) return;

    const icon = event.action === "added" ? "💧" : "⚠️";
    this.telegram.send(
      [
        `${icon} Liquidity ${verb} <b>${escapeHtml(symbol)}</b>`,
        `Chain: ${escapeHtml(config.chain.name)}`,
        `Wallet: ${explorerLink(config, "address", event.provider, event.provider)}`,
        `Tx: ${explorerLink(config, "tx", event.txHash, event.txHash)}`,
        `Tokens: ${formatToken(event.tokenAmount)} ${escapeHtml(symbol)}`,
        `Native: ${formatToken(event.nativeAmount)} ${config.nativeSymbol} (${formatUsd(event.usd)})`,
      ].join("\n"),
    );
  }
}
