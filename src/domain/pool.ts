import type { Address } from "viem";
import { toNumber } from "../core/format.js";
import type { LiveDeployment, TradeSide } from "./types.js";

export interface SwapArgs {
  amount0In: bigint;
  amount1In: bigint;
  amount0Out: bigint;
  amount1Out: bigint;
}

export interface Amounts {
  tokenAmount: bigint;
  nativeAmount: bigint;
}

export interface Trade extends Amounts {
  side: TradeSide;
}

export class Pool {
  reserveToken = 0n;
  reserveNative = 0n;
  buys = 0;
  sells = 0;
  boughtNative = 0n;
  soldNative = 0n;

  constructor(readonly deployment: LiveDeployment) {}

  get pair(): Address {
    return this.deployment.pair;
  }

  get supply(): number {
    return Number(this.deployment.supply);
  }

  sync(reserve0: bigint, reserve1: bigint): void {
    const t0 = this.deployment.tokenIsToken0;
    this.reserveToken = t0 ? reserve0 : reserve1;
    this.reserveNative = t0 ? reserve1 : reserve0;
  }

  priceNative(): number | null {
    if (this.reserveToken === 0n) return null;
    return toNumber(this.reserveNative) / toNumber(this.reserveToken);
  }

  swap(args: SwapArgs): Trade | null {
    const t0 = this.deployment.tokenIsToken0;
    const tokenIn = t0 ? args.amount0In : args.amount1In;
    const tokenOut = t0 ? args.amount0Out : args.amount1Out;
    const nativeIn = t0 ? args.amount1In : args.amount0In;
    const nativeOut = t0 ? args.amount1Out : args.amount0Out;

    if (nativeIn > nativeOut && tokenOut > tokenIn) {
      this.buys++;
      this.boughtNative += nativeIn - nativeOut;
      return {
        side: "buy",
        tokenAmount: tokenOut - tokenIn,
        nativeAmount: nativeIn - nativeOut,
      };
    }
    if (tokenIn > tokenOut && nativeOut > nativeIn) {
      this.sells++;
      this.soldNative += nativeOut - nativeIn;
      return {
        side: "sell",
        tokenAmount: tokenIn - tokenOut,
        nativeAmount: nativeOut - nativeIn,
      };
    }
    return null;
  }

  amounts(amount0: bigint, amount1: bigint): Amounts {
    const t0 = this.deployment.tokenIsToken0;
    return {
      tokenAmount: t0 ? amount0 : amount1,
      nativeAmount: t0 ? amount1 : amount0,
    };
  }
}
