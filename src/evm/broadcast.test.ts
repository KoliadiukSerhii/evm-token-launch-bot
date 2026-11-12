import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PublicClient } from "viem";
import { broadcastClients } from "./broadcast.js";

const fake = (id: number) => ({ id }) as unknown as PublicClient;
const pub = [fake(1), fake(2)];
const priv = [fake(9)];

describe("broadcastClients", () => {
  it("uses public clients for default broadcast", () => {
    const { clients, private: isPrivate } = broadcastClients(pub, priv, "public");
    assert.equal(clients, pub);
    assert.equal(isPrivate, false);
  });

  it("uses private clients for withdraw when configured", () => {
    const { clients, private: isPrivate } = broadcastClients(
      pub,
      priv,
      "withdraw",
    );
    assert.equal(clients, priv);
    assert.equal(isPrivate, true);
  });

  it("falls back to public withdraw when no private endpoints", () => {
    const { clients, private: isPrivate } = broadcastClients(pub, [], "withdraw");
    assert.equal(clients, pub);
    assert.equal(isPrivate, false);
  });
});
