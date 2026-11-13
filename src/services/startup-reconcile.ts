import type { ChainKey } from "../chains/types.js";
import { log } from "../core/logger.js";
import {
  assertSingleOccupant,
  findOccupyingDeployment,
} from "../domain/deployment-guards.js";
import { type Deployment, isLive } from "../domain/types.js";
import type { StateStore } from "../storage/state-store.js";
import type { TokenQueueStore } from "../storage/token-queue-store.js";

export async function reconcileStartup(
  chain: ChainKey,
  store: StateStore,
  queue: TokenQueueStore,
  cooldownMs: number,
): Promise<void> {
  const deployments = store.deployments(chain);
  const conflict = assertSingleOccupant(deployments, chain);
  if (conflict) {
    log.alertError(
      `[${chain}] multiple live/pending deployments — fix data/state.json before auto-deploy`,
      new Error(conflict),
    );
  }

  for (const deployment of deployments) {
    if (isLive(deployment) || deployment.status === "withdrawn") {
      await queue.ensureDeployedRecord(
        chain,
        deployment.symbol,
        deployment.token,
        deployedAtFor(deployment),
      );
    }
  }

  const occupying = findOccupyingDeployment(deployments, chain);
  if (occupying) {
    await queue.setActiveSymbol(chain, occupying.symbol);
    await queue.clearNextDeployAt(chain);
    return;
  }

  if (queue.nextDeployAt(chain)) return;

  const lastWithdrawn = deployments
    .filter((deployment) => deployment.status === "withdrawn" && deployment.withdrawnAt)
    .sort(
      (a, b) => Date.parse(b.withdrawnAt!) - Date.parse(a.withdrawnAt!),
    )[0];
  if (!lastWithdrawn?.withdrawnAt) return;

  const cooldownEnds =
    Date.parse(lastWithdrawn.withdrawnAt) + cooldownMs;
  if (Date.now() < cooldownEnds) {
    await queue.setNextDeployAt(chain, new Date(cooldownEnds).toISOString());
    log.info(`[${chain}] restored post-exit deploy cooldown`, {
      symbol: lastWithdrawn.symbol,
      until: new Date(cooldownEnds).toISOString(),
    });
  }
}

function deployedAtFor(deployment: Deployment): string {
  return deployment.withdrawnAt ?? deployment.createdAt;
}
