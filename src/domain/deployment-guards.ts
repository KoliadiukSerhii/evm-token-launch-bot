import type { ChainKey } from "../chains/types.js";
import type { Deployment } from "./types.js";

export function occupiesDeploySlot(deployment: Deployment): boolean {
  return deployment.status === "live" || deployment.status === "pending";
}

export function findOccupyingDeployment(
  deployments: Deployment[],
  chain?: ChainKey,
): Deployment | undefined {
  return deployments.find(
    (deployment) =>
      (chain === undefined || deployment.chain === chain) &&
      occupiesDeploySlot(deployment),
  );
}

export function assertSingleOccupant(
  deployments: Deployment[],
  chain: ChainKey,
): string | null {
  const occupants = deployments.filter(
    (deployment) => deployment.chain === chain && occupiesDeploySlot(deployment),
  );
  if (occupants.length <= 1) return null;
  return occupants.map((d) => `${d.symbol}:${d.status}`).join(", ");
}
