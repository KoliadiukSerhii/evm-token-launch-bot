import type { PublicClient } from "viem";

export type BroadcastMode = "public" | "withdraw";

export function broadcastClients(
  publicClients: PublicClient[],
  privateClients: PublicClient[],
  mode: BroadcastMode,
): { clients: PublicClient[]; private: boolean } {
  if (mode === "withdraw" && privateClients.length > 0) {
    return { clients: privateClients, private: true };
  }
  return { clients: publicClients, private: false };
}
