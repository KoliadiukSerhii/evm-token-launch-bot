import {
  BaseError,
  encodeFunctionData,
  formatEther,
  keccak256,
  maxUint256,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { erc20Abi, routerSwapAbi } from "../abi/index.js";
import { describeError } from "../core/errors.js";
import { log } from "../core/logger.js";
import type { SerialQueue } from "../core/serial.js";
import type { LiveDeployment } from "../domain/types.js";
import type { EvmClient } from "../evm/evm-client.js";

const GAS_BUFFER_PCT = 120n;
const RECEIPT_TIMEOUT_MS = 180_000;
const DEADLINE_SEC = 20 * 60;
const EXIT_SLIPPAGE_PCT = [5, 8, 12, 15, 20, 25, 30, 40];
const MANUAL_SLIPPAGE_PCT = [5];

export const MIN_BUY_NATIVE = parseEther("0.001");

export class TradeError extends Error {}

export function isUnsellable(error: unknown): boolean {
  const text = errorText(error).toLowerCase();
  return (
    text.includes("insufficient_liquidity") ||
    text.includes("insufficient liquidity") ||
    text.includes("insufficient_output") ||
    text.includes("insufficient output") ||
    text.includes("ds-math-sub-underflow") ||
    text.includes("pool quote is zero")
  );
}

function errorText(error: unknown): string {
  if (error instanceof BaseError) {
    return [error.shortMessage, error.details, error.message]
      .filter(Boolean)
      .join(" ");
  }
  return describeError(error);
}

export class TokenTrader {
  constructor(
    private readonly evm: EvmClient,
    private readonly queue: SerialQueue,
  ) {}

  /** Swap `percent` of the wallet's token balance to native. Does not touch LP. */
  sellPercent(deployment: LiveDeployment, percent: number): Promise<Hex> {
    if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
      return Promise.reject(
        new TradeError("percent must be an integer from 1 to 100"),
      );
    }
    return this.queue.run(() => this.sellPercentNow(deployment, percent));
  }

  /**
   * Swap the whole token balance. Caller must already hold `queue`
   * (the exit path does). Returns null when the wallet holds no tokens.
   */
  sellAllHeld(
    deployment: LiveDeployment,
    urgent: boolean,
  ): Promise<Hex | null> {
    return this.swapBalance(deployment, 100, EXIT_SLIPPAGE_PCT, urgent);
  }

  /** Swap an exact token amount. Caller must already hold `queue`. */
  sellExact(
    deployment: LiveDeployment,
    amount: bigint,
    urgent: boolean,
  ): Promise<Hex | null> {
    return this.swapAmount(deployment, amount, EXIT_SLIPPAGE_PCT, urgent);
  }

  buyNative(deployment: LiveDeployment, amount: bigint): Promise<Hex> {
    if (amount < MIN_BUY_NATIVE) {
      return Promise.reject(
        new TradeError(
          `minimum buy is 0.001 ${this.evm.config.nativeSymbol}`,
        ),
      );
    }
    return this.queue.run(() => this.buyNow(deployment, amount));
  }

  private async sellPercentNow(
    deployment: LiveDeployment,
    percent: number,
  ): Promise<Hex> {
    const hash = await this.swapBalance(
      deployment,
      percent,
      MANUAL_SLIPPAGE_PCT,
      false,
    );
    if (!hash) {
      throw new TradeError(
        `no ${deployment.symbol} balance to sell on ${deployment.chain}`,
      );
    }
    return hash;
  }

  private async swapBalance(
    deployment: LiveDeployment,
    percent: number,
    slippageSteps: number[],
    urgent: boolean,
  ): Promise<Hex | null> {
    const balance = await this.tokenBalance(deployment.token);
    const amount = (balance * BigInt(percent)) / 100n;
    return this.swapAmount(deployment, amount, slippageSteps, urgent);
  }

  private async swapAmount(
    deployment: LiveDeployment,
    amount: bigint,
    slippageSteps: number[],
    urgent: boolean,
  ): Promise<Hex | null> {
    if (amount === 0n) return null;
    await this.ensureAllowance(deployment.token, amount, urgent);
    let last: unknown;
    for (const slippage of slippageSteps) {
      try {
        return await this.swapTokensForNative(
          deployment,
          amount,
          slippage,
          urgent,
        );
      } catch (error) {
        last = error;
        if (!isUnsellable(error) || slippage === slippageSteps.at(-1)) {
          throw error;
        }
        log.warn(
          `[${deployment.chain}] ${deployment.symbol} sell at ${slippage}% slippage failed, widening`,
          { error: errorText(error) },
        );
      }
    }
    throw last;
  }

  private async buyNow(
    deployment: LiveDeployment,
    amount: bigint,
  ): Promise<Hex> {
    const { config } = this.evm;
    const balance = await this.evm.balance();
    if (balance <= amount) {
      throw new TradeError(
        `insufficient ${config.nativeSymbol}: need more than ${formatEther(amount)}, wallet has ${formatEther(balance)}`,
      );
    }
    const path = [config.dex.wrappedNative, deployment.token];
    const quoted = await this.quote(amount, path);
    const amountOutMin = (quoted * 95n) / 100n;
    const data = encodeFunctionData({
      abi: routerSwapAbi,
      functionName: "swapExactETHForTokens",
      args: [amountOutMin, path, this.evm.address, this.deadline()],
    });
    const hash = await this.send({
      to: config.dex.router,
      data,
      value: amount,
      urgent: false,
      label: `buy ${deployment.symbol}`,
    });
    log.info(`[${config.key}] bought ${deployment.symbol}`, {
      txHash: hash,
      spent: formatEther(amount),
    });
    return hash;
  }

  private async swapTokensForNative(
    deployment: LiveDeployment,
    amountIn: bigint,
    slippagePct: number,
    urgent: boolean,
  ): Promise<Hex> {
    const { config } = this.evm;
    const path = [deployment.token, config.dex.wrappedNative];
    const quoted = await this.quote(amountIn, path);
    const amountOutMin = (quoted * BigInt(100 - slippagePct)) / 100n;
    const data = encodeFunctionData({
      abi: routerSwapAbi,
      functionName: "swapExactTokensForETH",
      args: [amountIn, amountOutMin, path, this.evm.address, this.deadline()],
    });
    const hash = await this.send({
      to: config.dex.router,
      data,
      value: 0n,
      urgent,
      label: `sell ${deployment.symbol} @${slippagePct}%`,
    });
    log.info(`[${config.key}] sold ${deployment.symbol}`, {
      txHash: hash,
      amountIn: amountIn.toString(),
      slippagePct,
    });
    return hash;
  }

  private async ensureAllowance(
    token: Address,
    amount: bigint,
    urgent: boolean,
  ): Promise<void> {
    const router = this.evm.config.dex.router;
    const allowance = await this.evm.client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.evm.address, router],
    });
    if (allowance >= amount) return;
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [router, maxUint256],
    });
    await this.send({
      to: token,
      data,
      value: 0n,
      urgent,
      label: "approve token",
    });
  }

  private quote(amountIn: bigint, path: Address[]): Promise<bigint> {
    return this.evm.client
      .readContract({
        address: this.evm.config.dex.router,
        abi: routerSwapAbi,
        functionName: "getAmountsOut",
        args: [amountIn, path],
      })
      .then((amounts) => {
        const out = amounts[amounts.length - 1] ?? 0n;
        if (out === 0n) {
          throw new TradeError("pool quote is zero");
        }
        return out;
      });
  }

  private tokenBalance(token: Address): Promise<bigint> {
    return this.evm.client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [this.evm.address],
    });
  }

  private deadline(): bigint {
    return BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SEC);
  }

  private async send(tx: {
    to: Address;
    data: Hex;
    value: bigint;
    urgent: boolean;
    label: string;
  }): Promise<Hex> {
    const fees = await this.evm.fees(tx.urgent);
    const gasEstimate = await this.evm.estimateGas({
      to: tx.to,
      data: tx.data,
      value: tx.value,
    });
    const nonce = await this.evm.nonce();
    const signed = await this.evm.sign({
      to: tx.to,
      data: tx.data,
      value: tx.value,
      gas: (gasEstimate * GAS_BUFFER_PCT) / 100n,
      nonce,
      fees,
    });
    const hash = keccak256(signed);
    log.info(
      `[${this.evm.config.key}] broadcasting ${tx.label} via ${tx.urgent && this.evm.hasPrivateWithdrawRpc ? "private" : "public"} RPC`,
    );
    await this.evm.broadcast(signed, tx.urgent ? "withdraw" : "public");
    const receipt = await this.evm.waitForReceipt(hash, RECEIPT_TIMEOUT_MS);
    if (receipt.status !== "success") {
      throw new TradeError(`${tx.label} reverted`);
    }
    return hash;
  }
}

export function describeTradeError(error: unknown): string {
  return error instanceof TradeError ? error.message : describeError(error);
}
