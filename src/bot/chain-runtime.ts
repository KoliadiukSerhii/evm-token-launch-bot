import type { Hex } from "viem";
import type { ChainConfig, ChainKey } from "../chains/types.js";
import { SerialQueue } from "../core/serial.js";
import { EvmClient } from "../evm/evm-client.js";
import { LiquidityRemover } from "../services/liquidity-remover.js";
import { PoolMonitor } from "../services/pool-monitor.js";
import { NativePriceOracle } from "../services/price-oracle.js";
import { TokenLauncher } from "../services/token-launcher.js";
import { TokenTrader } from "../services/token-trader.js";
import type { StateStore } from "../storage/state-store.js";
import type { Reporter } from "./reporter.js";

export class ChainRuntime {
  readonly txQueue = new SerialQueue();
  readonly evm: EvmClient;
  readonly oracle: NativePriceOracle;
  readonly launcher: TokenLauncher;
  readonly trader: TokenTrader;
  readonly remover: LiquidityRemover;
  readonly monitor: PoolMonitor;

  constructor(
    readonly config: ChainConfig,
    rpcUrls: string[],
    withdrawRpcUrls: string[],
    privateKey: Hex,
    poolUsd: number,
    store: StateStore,
    reporter: Reporter,
  ) {
    this.evm = new EvmClient(config, rpcUrls, privateKey, withdrawRpcUrls);
    this.oracle = new NativePriceOracle(this.evm);
    this.launcher = new TokenLauncher(
      this.evm,
      this.oracle,
      store,
      poolUsd,
      this.txQueue,
    );
    this.trader = new TokenTrader(this.evm, this.txQueue);
    this.remover = new LiquidityRemover(
      this.evm,
      store,
      this.txQueue,
      this.trader,
      (line) => reporter.exitDetail(line),
    );
    this.monitor = new PoolMonitor(
      this.evm,
      this.oracle,
      store,
      (event, historical) => reporter.event(event, historical),
    );
  }

  get key(): ChainKey {
    return this.config.key;
  }
}
