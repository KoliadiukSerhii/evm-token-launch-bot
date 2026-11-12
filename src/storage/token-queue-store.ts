import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ChainKey } from "../chains/types.js";
import { SerialQueue } from "../core/serial.js";
import type { TokenSpec } from "../domain/types.js";

export interface DeployedRecord {
  symbol: string;
  token: string;
  deployedAt: string;
}

interface StoredToken {
  name: string;
  symbol: string;
  supply: string;
}

interface ChainQueue {
  queue: StoredToken[];
  deployed: DeployedRecord[];
  activeSymbol: string | null;
  nextDeployAt: string | null;
}

interface TokensFile {
  chains: Partial<Record<ChainKey, ChainQueue>>;
}

function emptyChain(): ChainQueue {
  return { queue: [], deployed: [], activeSymbol: null, nextDeployAt: null };
}

function toSpec(token: StoredToken): TokenSpec {
  return {
    name: token.name,
    symbol: token.symbol,
    supply: BigInt(token.supply),
  };
}

function toStored(spec: TokenSpec): StoredToken {
  return {
    name: spec.name,
    symbol: spec.symbol,
    supply: spec.supply.toString(),
  };
}

export class TokenQueueStore {
  private readonly writes = new SerialQueue();

  private constructor(
    private readonly path: string,
    private readonly data: TokensFile,
  ) {}

  static open(
    path = resolve(process.cwd(), "data", "tokens.json"),
  ): TokenQueueStore {
    mkdirSync(dirname(path), { recursive: true });
    const data: TokensFile = existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")) as TokensFile)
      : { chains: {} };
    if (!data.chains || typeof data.chains !== "object") data.chains = {};
    return new TokenQueueStore(path, data);
  }

  queue(chain: ChainKey): TokenSpec[] {
    return this.chain(chain).queue.map(toSpec);
  }

  syncFromEnv(chains: ChainKey[], envTokens: TokenSpec[]): Promise<void> {
    return this.mutate(() => {
      for (const chain of chains) {
        const state = this.chain(chain);
        const known = new Set(state.queue.map((token) => token.symbol));
        for (const spec of envTokens) {
          if (!known.has(spec.symbol)) {
            state.queue.push(toStored(spec));
            known.add(spec.symbol);
          }
        }
      }
    });
  }

  prepend(chain: ChainKey, spec: TokenSpec): Promise<void> {
    return this.mutate(() => {
      const state = this.chain(chain);
      state.queue = [
        toStored(spec),
        ...state.queue.filter((token) => token.symbol !== spec.symbol),
      ];
    });
  }

  reorder(chain: ChainKey, symbol: string, index: number): Promise<void> {
    const upper = symbol.toUpperCase();
    if (!Number.isInteger(index) || index < 0) {
      throw new Error("index must be a non-negative integer");
    }
    return this.mutate(() => {
      const state = this.chain(chain);
      const pos = state.queue.findIndex((token) => token.symbol === upper);
      if (pos === -1) throw new Error(`token ${upper} not in ${chain} queue`);
      const [item] = state.queue.splice(pos, 1);
      state.queue.splice(Math.min(index, state.queue.length), 0, item!);
    });
  }

  nextDeployable(chain: ChainKey): TokenSpec | undefined {
    const state = this.chain(chain);
    const deployed = new Set(state.deployed.map((record) => record.symbol));
    const next = state.queue.find((token) => !deployed.has(token.symbol));
    return next ? toSpec(next) : undefined;
  }

  hasDeployedSymbol(chain: ChainKey, symbol: string): boolean {
    const upper = symbol.toUpperCase();
    return this.chain(chain).deployed.some((record) => record.symbol === upper);
  }

  ensureDeployedRecord(
    chain: ChainKey,
    symbol: string,
    token: string,
    deployedAt: string,
  ): Promise<void> {
    const upper = symbol.toUpperCase();
    return this.mutate(() => {
      const state = this.chain(chain);
      if (!state.deployed.some((record) => record.symbol === upper)) {
        state.deployed.push({ symbol: upper, token, deployedAt });
      }
    });
  }

  recordDeployed(chain: ChainKey, symbol: string, token: string): Promise<void> {
    const upper = symbol.toUpperCase();
    return this.mutate(() => {
      const state = this.chain(chain);
      if (!state.deployed.some((record) => record.symbol === upper)) {
        state.deployed.push({
          symbol: upper,
          token,
          deployedAt: new Date().toISOString(),
        });
      }
      state.activeSymbol = upper;
    });
  }

  setActiveSymbol(chain: ChainKey, symbol: string | null): Promise<void> {
    return this.mutate(() => {
      this.chain(chain).activeSymbol = symbol ? symbol.toUpperCase() : null;
    });
  }

  activeSymbol(chain: ChainKey): string | null {
    return this.chain(chain).activeSymbol;
  }

  setNextDeployAt(chain: ChainKey, iso: string | null): Promise<void> {
    return this.mutate(() => {
      this.chain(chain).nextDeployAt = iso;
    });
  }

  clearNextDeployAt(chain: ChainKey): Promise<void> {
    return this.setNextDeployAt(chain, null);
  }

  applyPostExitCooldown(chain: ChainKey, delayMs: number): Promise<void> {
    return this.mutate(() => {
      const state = this.chain(chain);
      state.nextDeployAt = new Date(Date.now() + delayMs).toISOString();
      state.activeSymbol = null;
    });
  }

  nextDeployAt(chain: ChainKey): string | null {
    return this.chain(chain).nextDeployAt;
  }

  private chain(key: ChainKey): ChainQueue {
    return (this.data.chains[key] ??= emptyChain());
  }

  private mutate(edit: () => void): Promise<void> {
    return this.writes.run(async () => {
      edit();
      const snapshot = `${JSON.stringify(this.data, null, 2)}\n`;
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, snapshot);
      await rename(tmp, this.path);
    });
  }
}
