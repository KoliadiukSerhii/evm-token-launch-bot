import {
  type Address,
  createPublicClient,
  fallback,
  type Hex,
  http,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  webSocket,
} from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import type { ChainConfig } from "../chains/types.js";
import { broadcastClients, type BroadcastMode } from "./broadcast.js";
import { computeEip1559Fees, type Fees } from "./fees.js";

export type { Fees };

export interface UnsignedTx {
  to?: Address;
  data: Hex;
  value: bigint;
  gas: bigint;
  nonce: number;
  fees: Fees;
}

function isSocket(url: string): boolean {
  return url.startsWith("ws");
}

function transportFor(url: string, forceHttp = false): Transport {
  if (forceHttp || !isSocket(url)) {
    return http(url, { batch: true });
  }
  return webSocket(url, { keepAlive: true, reconnect: true });
}

function clientsForUrls(
  config: ChainConfig,
  urls: string[],
  forceHttp: boolean,
  pollingInterval: number,
): PublicClient[] {
  if (urls.length === 0) return [];
  const transports = [...urls]
    .sort((a, b) => Number(isSocket(b)) - Number(isSocket(a)))
    .map((url) => transportFor(url, forceHttp));
  return transports.map((transport) =>
    createPublicClient({
      chain: config.chain,
      transport,
      pollingInterval,
    }),
  );
}

export class EvmClient {
  readonly client: PublicClient;
  readonly account: PrivateKeyAccount;
  private readonly publicBroadcasters: PublicClient[];
  private readonly privateBroadcasters: PublicClient[];

  constructor(
    readonly config: ChainConfig,
    rpcUrls: string[],
    privateKey: Hex,
    withdrawRpcUrls: string[] = [],
  ) {
    const polling = config.pollingIntervalMs;
    const publicTransports = [...rpcUrls]
      .sort((a, b) => Number(isSocket(b)) - Number(isSocket(a)))
      .map((url) => transportFor(url));
    this.client = createPublicClient({
      chain: config.chain,
      transport:
        publicTransports.length === 1
          ? publicTransports[0]!
          : fallback(publicTransports),
      pollingInterval: polling,
    });
    this.publicBroadcasters = publicTransports.map((transport) =>
      createPublicClient({ chain: config.chain, transport, pollingInterval: polling }),
    );
    this.privateBroadcasters = clientsForUrls(
      config,
      withdrawRpcUrls,
      true,
      polling,
    );
    this.account = privateKeyToAccount(privateKey);
  }

  get hasPrivateWithdrawRpc(): boolean {
    return this.privateBroadcasters.length > 0;
  }

  get address(): Address {
    return this.account.address;
  }

  nonce(): Promise<number> {
    return this.client.getTransactionCount({
      address: this.address,
      blockTag: "pending",
    });
  }

  balance(): Promise<bigint> {
    return this.client.getBalance({ address: this.address });
  }

  async fees(urgent = false): Promise<Fees> {
    const [block, suggested] = await Promise.all([
      this.client.getBlock({ blockTag: "latest" }),
      this.client.estimateMaxPriorityFeePerGas(),
    ]);
    const chainFees = this.config.fees;
    const policy = urgent
      ? {
          priorityMultiplierPct: chainFees.withdrawPriorityMultiplierPct,
          minPriorityFee: chainFees.withdrawMinPriorityFee,
          baseFeeMultiplier: chainFees.withdrawBaseFeeMultiplier,
        }
      : {
          priorityMultiplierPct: chainFees.priorityMultiplierPct,
          minPriorityFee: chainFees.minPriorityFee,
          baseFeeMultiplier: 2n,
        };
    return computeEip1559Fees(
      block.baseFeePerGas ?? undefined,
      suggested,
      policy,
    );
  }

  estimateGas(request: {
    to?: Address;
    data: Hex;
    value: bigint;
  }): Promise<bigint> {
    return this.client.estimateGas({ account: this.address, ...request });
  }

  sign(tx: UnsignedTx): Promise<Hex> {
    return this.account.signTransaction({
      type: "eip1559",
      chainId: this.config.chain.id,
      to: tx.to,
      data: tx.data,
      value: tx.value,
      gas: tx.gas,
      nonce: tx.nonce,
      ...tx.fees,
    });
  }

  broadcast(
    serializedTransaction: Hex,
    mode: BroadcastMode = "public",
  ): Promise<Hex> {
    const { clients } = broadcastClients(
      this.publicBroadcasters,
      this.privateBroadcasters,
      mode,
    );
    return Promise.any(
      clients.map((client) =>
        client.sendRawTransaction({ serializedTransaction }),
      ),
    );
  }

  waitForReceipt(hash: Hex, timeout: number): Promise<TransactionReceipt> {
    return this.client.waitForTransactionReceipt({
      hash,
      timeout,
      pollingInterval: this.config.pollingIntervalMs,
    });
  }
}
