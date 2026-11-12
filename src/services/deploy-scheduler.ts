import type { ChainKey } from "../chains/types.js";
import { log } from "../core/logger.js";
import { SerialQueue } from "../core/serial.js";
import { scheduleAt, type ScheduledHandle } from "../core/time.js";
import { findOccupyingDeployment } from "../domain/deployment-guards.js";
import { isLive, type TokenSpec } from "../domain/types.js";
import type { StateStore } from "../storage/state-store.js";
import type { TokenQueueStore } from "../storage/token-queue-store.js";

export const POST_EXIT_DEPLOY_DELAY_MS = 5 * 60_000;

export type LaunchFn = (spec: TokenSpec) => Promise<boolean>;

export class DeployScheduler {
  private timer: ScheduledHandle | null = null;
  private readonly launches = new SerialQueue();
  private enabled = true;

  constructor(
    private readonly chain: ChainKey,
    private readonly queue: TokenQueueStore,
    private readonly store: StateStore,
    private readonly launch: LaunchFn,
  ) {}

  stop(): void {
    this.enabled = false;
    this.timer?.cancel();
    this.timer = null;
  }

  async bootstrap(): Promise<void> {
    const occupying = this.occupying();
    if (occupying && isLive(occupying)) {
      await this.queue.setActiveSymbol(this.chain, occupying.symbol);
      log.info(
        `[${this.chain}] deploy scheduler: resume live ${occupying.symbol}`,
      );
      return;
    }
    if (occupying?.status === "pending") {
      await this.queue.setActiveSymbol(this.chain, occupying.symbol);
      log.info(
        `[${this.chain}] deploy scheduler: resume pending ${occupying.symbol}`,
      );
      return;
    }
    await this.queue.setActiveSymbol(this.chain, null);
    this.scheduleOrDeploy();
  }

  async onCoinExited(): Promise<void> {
    if (!this.enabled) return;
    await this.queue.applyPostExitCooldown(
      this.chain,
      POST_EXIT_DEPLOY_DELAY_MS,
    );
    log.info(
      `[${this.chain}] deploy scheduler: next deploy in ${POST_EXIT_DEPLOY_DELAY_MS / 60_000} minutes`,
    );
    this.scheduleOrDeploy();
  }

  requestDeploy(spec: TokenSpec): Promise<string | null> {
    return this.launches.run(() => this.requestNow(spec));
  }

  /** Serialize a launch with auto-deploy and `/deploy` on this chain. */
  enqueue(task: () => Promise<boolean>): Promise<boolean> {
    return this.launches.run(task);
  }

  private occupying() {
    return findOccupyingDeployment(this.store.deployments(this.chain), this.chain);
  }

  private async requestNow(spec: TokenSpec): Promise<string | null> {
    const occupying = this.occupying();
    if (occupying) {
      if (isLive(occupying) && occupying.error) {
        return `Cannot deploy on ${this.chain}: exit not finished for ${occupying.symbol} (${occupying.error}) — cooldown paused`;
      }
      return `Cannot deploy on ${this.chain}: ${occupying.symbol} is ${occupying.status}`;
    }
    if (this.queue.hasDeployedSymbol(this.chain, spec.symbol)) {
      return `Cannot deploy ${spec.symbol} on ${this.chain}: already deployed before`;
    }
    const nextAt = this.queue.nextDeployAt(this.chain);
    if (nextAt && Date.parse(nextAt) > Date.now()) {
      const left = Math.ceil((Date.parse(nextAt) - Date.now()) / 60_000);
      return `Wait ${left}m after the last ${this.chain} exit before deploy (5m cooldown)`;
    }
    const ok = await this.launch(spec);
    return ok ? null : `Launch of ${spec.symbol} on ${this.chain} failed — see logs`;
  }

  private scheduleOrDeploy(): void {
    if (!this.enabled) return;
    this.timer?.cancel();
    this.timer = null;
    if (this.occupying()) return;

    const nextAt = this.queue.nextDeployAt(this.chain);
    if (nextAt) {
      const deadline = Date.parse(nextAt);
      if (deadline > Date.now()) {
        this.timer = scheduleAt(deadline, () => {
          void this.tryDeployNext();
        });
        return;
      }
    }
    void this.tryDeployNext();
  }

  private async tryDeployNext(): Promise<void> {
    if (!this.enabled) return;
    await this.launches.run(async () => {
      if (!this.enabled) return;
      if (this.occupying()) return;
      const spec = this.queue.nextDeployable(this.chain);
      if (!spec) {
        log.info(
          `[${this.chain}] deploy scheduler: queue empty or all symbols already deployed`,
        );
        return;
      }
      const nextAt = this.queue.nextDeployAt(this.chain);
      if (nextAt && Date.parse(nextAt) > Date.now()) return;
      await this.launch(spec);
    });
  }
}
