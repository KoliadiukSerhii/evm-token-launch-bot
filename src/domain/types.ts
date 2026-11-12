import type { Address, Hex } from "viem";
import type { ChainKey } from "../chains/types.js";

export const TOKEN_DECIMALS = 18;

export interface TokenSpec {
  name: string;
  symbol: string;
  supply: bigint;
}

export type DeploymentStatus = "pending" | "live" | "failed" | "withdrawn";

export interface Deployment {
  chain: ChainKey;
  symbol: string;
  name: string;
  supply: string;
  status: DeploymentStatus;
  txHash: Hex;
  nonce: number;
  poolUsd: number;
  poolNative: string;
  token: Address;
  pair?: Address;
  tokenIsToken0?: boolean;
  block?: string;
  createdAt: string;
  /** ISO time when the pool auto-withdraw timer fires (unset if disabled). */
  poolExpiresAt?: string;
  poolLifetimeDisabled?: boolean;
  withdrawTxHash?: Hex;
  /** remove-liquidity and token-sell hashes from the exit. */
  exitTxHashes?: Hex[];
  withdrawnAt?: string;
  error?: string;
}

export type LiveDeployment = Deployment &
  Required<Pick<Deployment, "pair" | "tokenIsToken0" | "block">>;

export function isLive(deployment: Deployment): deployment is LiveDeployment {
  return (
    deployment.status === "live" &&
    deployment.pair !== undefined &&
    deployment.tokenIsToken0 !== undefined &&
    deployment.block !== undefined
  );
}

export type TradeSide = "buy" | "sell";

export interface TradeEvent {
  kind: "trade";
  side: TradeSide;
  deployment: LiveDeployment;
  trader: Address;
  tokenAmount: bigint;
  nativeAmount: bigint;
  usd: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  txHash: Hex;
  block: bigint;
}

export interface LiquidityEvent {
  kind: "liquidity";
  action: "added" | "removed";
  deployment: LiveDeployment;
  provider: Address;
  tokenAmount: bigint;
  nativeAmount: bigint;
  usd: number | null;
  txHash: Hex;
  block: bigint;
}

export type PoolEvent = TradeEvent | LiquidityEvent;
