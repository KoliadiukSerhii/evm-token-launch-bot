import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ChainKey } from "../chains/types.js";
import { SerialQueue } from "../core/serial.js";
import type { Deployment } from "../domain/types.js";

const CURSOR_FLUSH_MS = 5_000;

interface StateFile {
  deployments: Deployment[];
  cursors: Partial<Record<ChainKey, string>>;
}

export class StateStore {
  private readonly writes = new SerialQueue();
  private cursorTimer: NodeJS.Timeout | null = null;

  private constructor(
    private readonly path: string,
    private readonly state: StateFile,
  ) {}

  static open(path = resolve(process.cwd(), "data", "state.json")): StateStore {
    mkdirSync(dirname(path), { recursive: true });
    const state: StateFile = existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")) as StateFile)
      : { deployments: [], cursors: {} };
    return new StateStore(path, state);
  }

  deployments(chain?: ChainKey): Deployment[] {
    return this.state.deployments.filter((d) => !chain || d.chain === chain);
  }

  get(chain: ChainKey, symbol: string): Deployment | undefined {
    return this.state.deployments.find(
      (d) => d.chain === chain && d.symbol === symbol,
    );
  }

  upsert(deployment: Deployment): Promise<void> {
    const index = this.state.deployments.findIndex(
      (d) => d.chain === deployment.chain && d.symbol === deployment.symbol,
    );
    if (index === -1) this.state.deployments.push(deployment);
    else this.state.deployments[index] = deployment;
    return this.persist();
  }

  cursor(chain: ChainKey): bigint | null {
    const value = this.state.cursors[chain];
    return value === undefined ? null : BigInt(value);
  }

  setCursor(chain: ChainKey, block: bigint): void {
    this.state.cursors[chain] = block.toString();
    this.cursorTimer ??= setTimeout(() => {
      this.cursorTimer = null;
      void this.persist();
    }, CURSOR_FLUSH_MS);
  }

  flush(): Promise<void> {
    if (this.cursorTimer) clearTimeout(this.cursorTimer);
    this.cursorTimer = null;
    return this.persist();
  }

  private persist(): Promise<void> {
    const snapshot = `${JSON.stringify(this.state, null, 2)}\n`;
    return this.writes.run(async () => {
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, snapshot);
      await rename(tmp, this.path);
    });
  }
}
