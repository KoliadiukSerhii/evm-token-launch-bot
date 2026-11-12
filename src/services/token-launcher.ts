import {
  encodeDeployData,
  formatEther,
  getContractAddress,
  keccak256,
  parseEventLogs,
  parseUnits,
  type TransactionReceipt,
  WaitForTransactionReceiptTimeoutError,
} from "viem";
import { launchedEventAbi, loadArtifact } from "../abi/index.js";
import { describeError } from "../core/errors.js";
import { log } from "../core/logger.js";
import { SerialQueue } from "../core/serial.js";
import {
  type Deployment,
  isLive,
  type LiveDeployment,
  TOKEN_DECIMALS,
  type TokenSpec,
} from "../domain/types.js";
import type { EvmClient } from "../evm/evm-client.js";
import type { StateStore } from "../storage/state-store.js";
import type { NativePriceOracle } from "./price-oracle.js";

const ESTIMATE_VALUE = 10n ** 9n;
const GAS_BUFFER_PCT = 120n;
const RECEIPT_TIMEOUT_MS = 180_000;

export class LaunchError extends Error {}

export class TokenLauncher {
  private readonly artifact = loadArtifact("TokenLaunch");

  constructor(
    private readonly evm: EvmClient,
    private readonly oracle: NativePriceOracle,
    private readonly store: StateStore,
    private readonly poolUsd: number,
    private readonly queue: SerialQueue,
  ) {}

  launch(spec: TokenSpec): Promise<LiveDeployment> {
    return this.queue.run(() => this.launchNow(spec));
  }

  recover(pending: Deployment): Promise<LiveDeployment> {
    return this.queue.run(() => this.resume(pending));
  }

  private async launchNow(spec: TokenSpec): Promise<LiveDeployment> {
    const { config } = this.evm;
    const existing = this.store.get(config.key, spec.symbol);
    if (existing && isLive(existing)) return existing;
    if (existing?.status === "pending") return this.resume(existing);

    const data = encodeDeployData({
      abi: this.artifact.abi,
      bytecode: this.artifact.bytecode,
      args: [
        spec.name,
        spec.symbol,
        parseUnits(spec.supply.toString(), TOKEN_DECIMALS),
        config.dex.router,
      ],
    });

    const [nonce, fees, gasEstimate, price, balance] = await Promise.all([
      this.evm.nonce(),
      this.evm.fees(),
      this.evm.estimateGas({ data, value: ESTIMATE_VALUE }),
      this.oracle.fresh(),
      this.evm.balance(),
    ]);

    const value = this.oracle.toNative(this.poolUsd, price);
    const gas = (gasEstimate * GAS_BUFFER_PCT) / 100n;
    const required = value + gas * fees.maxFeePerGas;
    if (balance < required) {
      throw new LaunchError(
        `insufficient funds: need ${formatEther(required)} ${config.nativeSymbol}, wallet has ${formatEther(balance)}`,
      );
    }

    const signed = await this.evm.sign({ data, value, gas, nonce, fees });
    const launcher = getContractAddress({
      from: this.evm.address,
      nonce: BigInt(nonce),
    });
    const pending: Deployment = {
      chain: config.key,
      symbol: spec.symbol,
      name: spec.name,
      supply: spec.supply.toString(),
      status: "pending",
      txHash: keccak256(signed),
      nonce,
      poolUsd: this.poolUsd,
      poolNative: value.toString(),
      token: getContractAddress({ from: launcher, nonce: 1n }),
      createdAt: new Date().toISOString(),
    };
    await this.store.upsert(pending);

    try {
      await this.evm.broadcast(signed);
    } catch (error) {
      const known = await this.evm.client
        .getTransaction({ hash: pending.txHash })
        .catch(() => null);
      if (!known) return this.fail(pending, describeError(error));
    }

    log.info(`[${config.key}] launch tx sent`, {
      symbol: spec.symbol,
      txHash: pending.txHash,
      token: pending.token,
      poolNative: formatEther(value),
      nativeUsd: price.usd,
      gas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    return this.confirm(pending);
  }

  private async resume(pending: Deployment): Promise<LiveDeployment> {
    const receipt = await this.receipt(pending);
    if (receipt) return this.finalize(pending, receipt);

    const confirmedNonce = await this.evm.client.getTransactionCount({
      address: this.evm.address,
      blockTag: "latest",
    });
    if (confirmedNonce > pending.nonce) {
      const late = await this.receipt(pending);
      if (late) return this.finalize(pending, late);
      return this.fail(pending, "nonce consumed by another transaction");
    }
    return this.confirm(pending);
  }

  private async confirm(pending: Deployment): Promise<LiveDeployment> {
    try {
      const receipt = await this.evm.waitForReceipt(
        pending.txHash,
        RECEIPT_TIMEOUT_MS,
      );
      return await this.finalize(pending, receipt);
    } catch (error) {
      if (!(error instanceof WaitForTransactionReceiptTimeoutError)) {
        throw error;
      }
      const known = await this.evm.client
        .getTransaction({ hash: pending.txHash })
        .catch(() => null);
      if (!known) return this.fail(pending, "transaction dropped");
      throw new LaunchError(
        `launch tx ${pending.txHash} still pending after ${RECEIPT_TIMEOUT_MS / 1000}s`,
      );
    }
  }

  private async finalize(
    pending: Deployment,
    receipt: TransactionReceipt,
  ): Promise<LiveDeployment> {
    if (receipt.status !== "success") {
      return this.fail(
        { ...pending, block: receipt.blockNumber.toString() },
        "transaction reverted",
      );
    }
    const [event] = parseEventLogs({
      abi: launchedEventAbi,
      logs: receipt.logs,
      eventName: "Launched",
    });
    if (!event) return this.fail(pending, "Launched event not found");

    const { token, pair } = event.args;
    const live: LiveDeployment = {
      ...pending,
      status: "live",
      token,
      pair,
      tokenIsToken0: BigInt(token) < BigInt(this.evm.config.dex.wrappedNative),
      block: receipt.blockNumber.toString(),
      error: undefined,
    };
    await this.store.upsert(live);
    return live;
  }

  private receipt(pending: Deployment): Promise<TransactionReceipt | null> {
    return this.evm.client
      .getTransactionReceipt({ hash: pending.txHash })
      .catch(() => null);
  }

  private async fail(deployment: Deployment, reason: string): Promise<never> {
    await this.store.upsert({ ...deployment, status: "failed", error: reason });
    throw new LaunchError(`launch of ${deployment.symbol} failed: ${reason}`);
  }
}
