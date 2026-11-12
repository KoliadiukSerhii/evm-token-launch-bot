import {
  encodeFunctionData,
  formatEther,
  keccak256,
  maxUint256,
  type Hex,
} from "viem";
import {
  erc20Abi,
  pairReadAbi,
  routerLiquidityAbi,
  routerReadAbi,
} from "../abi/index.js";
import { describeError } from "../core/errors.js";
import { log } from "../core/logger.js";
import type { SerialQueue } from "../core/serial.js";
import type { Deployment, LiveDeployment } from "../domain/types.js";
import type { EvmClient } from "../evm/evm-client.js";
import type { StateStore } from "../storage/state-store.js";
import { isUnsellable, type TokenTrader } from "./token-trader.js";

const GAS_BUFFER_PCT = 120n;
const RECEIPT_TIMEOUT_MS = 180_000;
const REMOVE_DEADLINE_SEC = 20 * 60;
const MIN_OUT_PCT = 99n;

export class LiquidityRemoveError extends Error {}

export class LiquidityRemover {
  private routerChecked = false;

  constructor(
    private readonly evm: EvmClient,
    private readonly store: StateStore,
    private readonly queue: SerialQueue,
    private readonly trader: TokenTrader,
    private readonly onDetail: (line: string) => void = () => {},
  ) {}

  withdraw(
    deployment: LiveDeployment,
    options: { sellWalletFirst?: boolean } = {},
  ): Promise<Deployment> {
    return this.queue.run(() => this.withdrawNow(deployment, options));
  }

  private async broadcastWithdraw(
    serialized: Hex,
    label: string,
  ): Promise<void> {
    const privateRpc = this.evm.hasPrivateWithdrawRpc;
    log.info(
      `[${this.evm.config.key}] broadcasting withdraw tx (${label}) via ${privateRpc ? "private" : "public"} RPC`,
    );
    await this.evm.broadcast(serialized, "withdraw");
  }

  private async assertRouter(router: `0x${string}`): Promise<void> {
    if (this.routerChecked) return;
    const wrapped = await this.evm.client.readContract({
      address: router,
      abi: routerReadAbi,
      functionName: "WETH",
    });
    if (wrapped.toLowerCase() !== this.evm.config.dex.wrappedNative.toLowerCase()) {
      throw new LiquidityRemoveError(
        `router WETH ${wrapped} != configured wrapped native ${this.evm.config.dex.wrappedNative}`,
      );
    }
    this.routerChecked = true;
  }

  private async minRemoveAmounts(
    deployment: LiveDeployment,
    pair: `0x${string}`,
    lpBalance: bigint,
  ): Promise<{ amountTokenMin: bigint; amountETHMin: bigint }> {
    const [reserves, totalSupply] = await Promise.all([
      this.evm.client.readContract({
        address: pair,
        abi: pairReadAbi,
        functionName: "getReserves",
      }),
      this.evm.client.readContract({
        address: pair,
        abi: pairReadAbi,
        functionName: "totalSupply",
      }),
    ]);
    const [reserve0, reserve1] = reserves;
    if (totalSupply === 0n) {
      return { amountTokenMin: 0n, amountETHMin: 0n };
    }
    const amount0 = (lpBalance * reserve0) / totalSupply;
    const amount1 = (lpBalance * reserve1) / totalSupply;
    const tokenAmount = deployment.tokenIsToken0 ? amount0 : amount1;
    const nativeAmount = deployment.tokenIsToken0 ? amount1 : amount0;
    return {
      amountTokenMin: (tokenAmount * MIN_OUT_PCT) / 100n,
      amountETHMin: (nativeAmount * MIN_OUT_PCT) / 100n,
    };
  }

  private async tokenBalance(token: Deployment["token"]): Promise<bigint> {
    return this.evm.client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [this.evm.address],
    });
  }

  /** Swap `amount` of the token. An empty pool is not a failure. */
  private async sellAmount(
    deployment: LiveDeployment,
    amount: bigint,
  ): Promise<Hex | null> {
    try {
      const hash = await this.trader.sellExact(deployment, amount, true);
      if (hash) {
        this.onDetail(
          `[${deployment.chain}] sold ${deployment.symbol} ${hash}`,
        );
      }
      return hash;
    } catch (error) {
      if (!isUnsellable(error)) throw error;
      const line = `[${deployment.chain}] ${deployment.symbol} could not be swapped: pool has no remaining liquidity`;
      log.info(line);
      this.onDetail(line);
      return null;
    }
  }

  private async withdrawNow(
    deployment: LiveDeployment,
    options: { sellWalletFirst?: boolean },
  ): Promise<Deployment> {
    const current = this.store.get(deployment.chain, deployment.symbol);
    if (current?.status === "withdrawn") return current;

    const { config } = this.evm;
    const router = config.dex.router;
    const pair = deployment.pair;
    await this.assertRouter(router);
    const exitTxHashes: Hex[] = [...(deployment.exitTxHashes ?? [])];
    const sellWalletFirst = options.sellWalletFirst !== false;
    let kept = 0n;
    if (sellWalletFirst) {
      const balance = await this.tokenBalance(deployment.token);
      const soldBefore = await this.sellAmount(deployment, balance);
      if (soldBefore) exitTxHashes.push(soldBefore);
    } else {
      kept = await this.tokenBalance(deployment.token);
    }

    let lpBalance = await this.evm.client.readContract({
      address: pair,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [this.evm.address],
    });
    if (lpBalance === 0n) {
      const balance = await this.tokenBalance(deployment.token);
      const soldAfter = await this.sellAmount(deployment, balance);
      if (soldAfter) exitTxHashes.push(soldAfter);
      const leftover = await this.tokenBalance(deployment.token);
      if (leftover > 0n) {
        log.alert(
          `[${config.key}] ${deployment.symbol} exit finished with ${leftover} tokens left (no pool liquidity to swap into)`,
        );
      }
      return this.markWithdrawn(deployment, exitTxHashes);
    }

    const allowance = await this.evm.client.readContract({
      address: pair,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.evm.address, router],
    });

    const withdrawFees = () => this.evm.fees(true);
    const [nonce, fees] = await Promise.all([
      this.evm.nonce(),
      withdrawFees(),
    ]);
    let nextNonce = nonce;

    if (allowance < lpBalance) {
      const approveData = encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [router, maxUint256],
      });
      const approveGas = await this.evm.estimateGas({
        to: pair,
        data: approveData,
        value: 0n,
      });
      const signedApprove = await this.evm.sign({
        to: pair,
        data: approveData,
        value: 0n,
        gas: (approveGas * GAS_BUFFER_PCT) / 100n,
        nonce: nextNonce,
        fees,
      });
      const approveHash = keccak256(signedApprove);
      await this.broadcastWithdraw(signedApprove, "approve");
      await this.evm.waitForReceipt(approveHash, RECEIPT_TIMEOUT_MS);
      nextNonce += 1;
      lpBalance = await this.evm.client.readContract({
        address: pair,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [this.evm.address],
      });
      if (lpBalance === 0n) {
        const balance = await this.tokenBalance(deployment.token);
        const sold = await this.sellAmount(
          deployment,
          balance > kept ? balance - kept : balance,
        );
        if (sold) exitTxHashes.push(sold);
        return this.markWithdrawn(deployment, exitTxHashes);
      }
    }

    const removeFees = nextNonce === nonce ? fees : await withdrawFees();
    const { amountTokenMin, amountETHMin } = await this.minRemoveAmounts(
      deployment,
      pair,
      lpBalance,
    );
    const deadline = BigInt(
      Math.floor(Date.now() / 1000) + REMOVE_DEADLINE_SEC,
    );
    const removeData = encodeFunctionData({
      abi: routerLiquidityAbi,
      functionName: "removeLiquidityETH",
      args: [
        deployment.token,
        lpBalance,
        amountTokenMin,
        amountETHMin,
        this.evm.address,
        deadline,
      ],
    });
    const removeGas = await this.evm.estimateGas({
      to: router,
      data: removeData,
      value: 0n,
    });
    const signedRemove = await this.evm.sign({
      to: router,
      data: removeData,
      value: 0n,
      gas: (removeGas * GAS_BUFFER_PCT) / 100n,
      nonce: nextNonce,
      fees: removeFees,
    });
    const removeHash = keccak256(signedRemove);
    await this.broadcastWithdraw(signedRemove, "removeLiquidityETH");
    const receipt = await this.evm.waitForReceipt(
      removeHash,
      RECEIPT_TIMEOUT_MS,
    );
    if (receipt.status !== "success") {
      throw new LiquidityRemoveError("removeLiquidityETH reverted");
    }
    exitTxHashes.push(removeHash);
    this.onDetail(
      `[${config.key}] removed LP for ${deployment.symbol} ${removeHash}`,
    );

    const after = await this.tokenBalance(deployment.token);
    const received = after > kept ? after - kept : 0n;
    const soldAfter = await this.sellAmount(deployment, received);
    if (soldAfter) exitTxHashes.push(soldAfter);
    const leftover = await this.tokenBalance(deployment.token);
    const stuck = leftover > kept ? leftover - kept : 0n;
    if (stuck > 0n) {
      log.alert(
        `[${config.key}] ${deployment.symbol} exit finished with ${stuck} tokens left (no pool liquidity to swap into)`,
      );
    }
    return this.markWithdrawn(deployment, exitTxHashes, lpBalance);
  }

  private async markWithdrawn(
    deployment: LiveDeployment,
    exitTxHashes: Hex[],
    lp: bigint = 0n,
  ): Promise<Deployment> {
    const withdrawTxHash = exitTxHashes.at(-1);
    const updated: Deployment = {
      ...deployment,
      status: "withdrawn",
      poolExpiresAt: undefined,
      withdrawTxHash,
      exitTxHashes,
      withdrawnAt: new Date().toISOString(),
      error: undefined,
    };
    await this.store.upsert(updated);
    log.info(`[${deployment.chain}] pool withdrawn for ${deployment.symbol}`, {
      txHash: withdrawTxHash,
      exitTxHashes,
      lp: lp.toString(),
      nativeAfter: formatEther(await this.evm.balance()),
    });
    return updated;
  }
}

export function describeLiquidityError(error: unknown): string {
  return error instanceof LiquidityRemoveError
    ? error.message
    : describeError(error);
}
