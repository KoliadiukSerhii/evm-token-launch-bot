import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { Address, Hex } from "viem";
import type { ChainKey } from "../chains/types.js";
import type { Deployment, LiveDeployment } from "../domain/types.js";
import { StateStore } from "../storage/state-store.js";
import type { LiquidityRemover } from "./liquidity-remover.js";
import {
  PoolLifetimeManager,
  type ExitReason,
} from "./pool-lifetime.js";

const dir = await mkdtemp(join(tmpdir(), "token-sell-all-"));
after(() => rm(dir, { recursive: true, force: true }));

function live(chain: ChainKey, symbol: string, expiresInMs = 60_000): LiveDeployment {
  return {
    chain,
    symbol,
    name: symbol,
    supply: "1000",
    status: "live",
    txHash: `0x${"ab".repeat(32)}` as Hex,
    nonce: 1,
    poolUsd: 10,
    poolNative: "1",
    token: `0x${"11".repeat(20)}` as Address,
    pair: `0x${"22".repeat(20)}` as Address,
    tokenIsToken0: true,
    block: "1",
    createdAt: new Date().toISOString(),
    poolExpiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  };
}

describe("sellAll", () => {
  it("sells the only live token, wallet first, and ignores a second request", async () => {
    const store = StateStore.open(join(dir, "one.json"));
    const coin = live("base", "BRAND", 300);
    await store.upsert(coin);
    const calls: { symbol: string; sellWalletFirst?: boolean }[] = [];
    let finish: (deployment: Deployment) => void = () => {};
    const remover = {
      async withdraw(
        deployment: LiveDeployment,
        options: { sellWalletFirst?: boolean } = {},
      ): Promise<Deployment> {
        calls.push({
          symbol: deployment.symbol,
          sellWalletFirst: options.sellWalletFirst,
        });
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    } as unknown as LiquidityRemover;
    const reasons: ExitReason[] = [];
    const manager = new PoolLifetimeManager(
      store,
      60_000,
      (_deployment, reason) => {
        reasons.push(reason);
      },
    );
    manager.registerRuntime("base", remover);
    await manager.onLaunched(coin);

    const started = manager.sellAll();
    assert.deepEqual(started, { chain: "base", symbol: "BRAND" });
    assert.deepEqual(manager.sellAll(), {
      error: "BRAND on base is already selling",
    });
    assert.deepEqual(calls, [{ symbol: "BRAND", sellWalletFirst: true }]);

    finish(coin);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(reasons, ["manual"]);
    assert.deepEqual(calls, [{ symbol: "BRAND", sellWalletFirst: true }]);

    const withdrawn: Deployment = {
      ...coin,
      status: "withdrawn",
      withdrawnAt: new Date().toISOString(),
    };
    await store.upsert(withdrawn);
    assert.deepEqual(manager.sellAll(), { error: "no live token — deploy first" });
    assert.deepEqual(manager.sellAll("BRAND", "base"), {
      error: "BRAND is not live on base",
    });
    manager.stop();
  });

  it("requires a symbol when more than one token is live", async () => {
    const store = StateStore.open(join(dir, "many.json"));
    await store.upsert(live("base", "ONE"));
    await store.upsert(live("ethereum", "TWO"));
    const calls: string[] = [];
    const remover = {
      async withdraw(deployment: LiveDeployment): Promise<Deployment> {
        calls.push(`${deployment.chain}:${deployment.symbol}`);
        return {
          ...deployment,
          status: "withdrawn",
          withdrawnAt: new Date().toISOString(),
        };
      },
    } as unknown as LiquidityRemover;
    const manager = new PoolLifetimeManager(store, 60_000, () => {});
    manager.registerRuntime("base", remover);
    manager.registerRuntime("ethereum", remover);

    const missing = manager.sellAll();
    assert.equal("error" in missing, true);
    if ("error" in missing) assert.match(missing.error, /ONE on base/);
    assert.deepEqual(manager.sellAll("two"), { chain: "ethereum", symbol: "TWO" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(calls, ["ethereum:TWO"]);
    assert.deepEqual(manager.sellAll("ONE", "ethereum"), {
      error: "ONE is not live on ethereum",
    });
    assert.deepEqual(manager.sellAll(undefined, "base"), {
      chain: "base",
      symbol: "ONE",
    });
    manager.stop();
  });

  it("asks for the chain when the same symbol is live on two chains", async () => {
    const store = StateStore.open(join(dir, "same.json"));
    const manager = new PoolLifetimeManager(store, 60_000, () => {});
    const remover = {
      withdraw: async () => {
        throw new Error("should not sell");
      },
    } as unknown as LiquidityRemover;
    manager.registerRuntime("base", remover);
    manager.registerRuntime("ethereum", remover);
    await store.upsert(live("base", "BRAND"));
    await store.upsert(live("ethereum", "BRAND"));
    const result = manager.sellAll("brand");
    assert.deepEqual(result, {
      error: "BRAND is live on base, ethereum; use /sell_all BRAND CHAIN",
    });
    manager.stop();
  });

  it("reports when nothing is live", () => {
    const store = StateStore.open(join(dir, "empty.json"));
    const manager = new PoolLifetimeManager(store, 60_000, () => {});
    manager.registerRuntime("base", {
      withdraw: async () => {
        throw new Error("should not sell");
      },
    } as unknown as LiquidityRemover);
    assert.deepEqual(manager.sellAll(), { error: "no live token — deploy first" });
    assert.deepEqual(manager.sellAll(undefined, "base"), {
      error: "no live token on base",
    });
    manager.stop();
  });
});
