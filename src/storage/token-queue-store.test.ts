import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Address, Hex } from "viem";
import { parseTokenEntry } from "../core/token-spec.js";
import { findOccupyingDeployment } from "../domain/deployment-guards.js";
import type { Deployment, TokenSpec } from "../domain/types.js";
import { DeployScheduler } from "../services/deploy-scheduler.js";
import { takeRetryDelay } from "../services/exit-retry.js";
import { isUnsellable } from "../services/token-trader.js";
import { StateStore } from "./state-store.js";
import { TokenQueueStore } from "./token-queue-store.js";

const spec: TokenSpec = { name: "Alpha", symbol: "ALPHA", supply: 1000n };
const second: TokenSpec = { name: "Beta", symbol: "BETA", supply: 1000n };

function live(chain: Deployment["chain"], symbol: string): Deployment {
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
  };
}

test("parseTokenEntry accepts name, symbol, and supply", () => {
  assert.deepEqual(parseTokenEntry("My Token:abcd:5"), {
    name: "My Token",
    symbol: "ABCD",
    supply: 5n,
  });
  assert.equal(parseTokenEntry("Solo:SOLO").supply, 1_000_000_000n);
  assert.throws(() => parseTokenEntry("Bad:"), /Name:SYMBOL/);
});

test("exit retry doubles from 5s and caps at 5m", () => {
  const first = takeRetryDelay(undefined);
  assert.equal(first.wait, 5_000);
  assert.equal(first.next, 10_000);
  const capped = takeRetryDelay(5 * 60_000);
  assert.equal(capped.wait, 5 * 60_000);
  assert.equal(capped.next, 5 * 60_000);
});

test("unsellable pool errors do not fail a finished exit", () => {
  assert.equal(isUnsellable(new Error("INSUFFICIENT_LIQUIDITY")), true);
  assert.equal(isUnsellable(new Error("pool quote is zero")), true);
  assert.equal(isUnsellable(new Error("nonce too low")), false);
});

test("a live token occupies only its own chain", () => {
  const deployments = [live("base", "ALPHA")];
  assert.equal(findOccupyingDeployment(deployments, "base")?.symbol, "ALPHA");
  assert.equal(findOccupyingDeployment(deployments, "ethereum"), undefined);
});

test("each chain keeps its own queue, deployed set, and cooldown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "token-queue-"));
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const queue = TokenQueueStore.open(join(dir, "tokens.json"));
  await queue.syncFromEnv(["ethereum", "base"], [spec, second]);
  await queue.recordDeployed("base", "ALPHA", "0xabc");
  await queue.reorder("ethereum", "BETA", 0);

  assert.equal(queue.nextDeployable("base")?.symbol, "BETA");
  assert.equal(queue.nextDeployable("ethereum")?.symbol, "BETA");
  assert.deepEqual(
    queue.queue("ethereum").map((token) => token.symbol),
    ["BETA", "ALPHA"],
  );
  assert.equal(queue.hasDeployedSymbol("ethereum", "ALPHA"), false);
  assert.equal(queue.hasDeployedSymbol("base", "ALPHA"), true);

  await queue.applyPostExitCooldown("base", 5 * 60_000);
  assert.equal(queue.activeSymbol("base"), null);
  assert.ok(Date.parse(queue.nextDeployAt("base")!) > Date.now());
  assert.equal(queue.nextDeployAt("ethereum"), null);

  const reopened = TokenQueueStore.open(join(dir, "tokens.json"));
  assert.equal(reopened.nextDeployable("base")?.symbol, "BETA");
  assert.equal(reopened.queue("ethereum")[0]?.symbol, "BETA");
});

test("one chain can deploy while another chain's slot is taken", async () => {
  const dir = await mkdtemp(join(tmpdir(), "token-sched-"));
  const queue = TokenQueueStore.open(join(dir, "tokens.json"));
  const store = StateStore.open(join(dir, "state.json"));
  await queue.syncFromEnv(["ethereum", "base"], [spec]);
  await store.upsert(live("base", "ALPHA"));

  const launched: string[] = [];
  const ethereum = new DeployScheduler("ethereum", queue, store, async () => {
    launched.push("ethereum");
    return true;
  });
  const base = new DeployScheduler("base", queue, store, async () => {
    launched.push("base");
    return true;
  });
  await ethereum.bootstrap();
  await base.bootstrap();
  for (let i = 0; i < 20 && !launched.includes("ethereum"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  ethereum.stop();
  base.stop();
  await rm(dir, { recursive: true, force: true });

  assert.deepEqual(launched, ["ethereum"]);
  const blocked = await base.requestDeploy(spec);
  assert.match(blocked ?? "", /ALPHA is live/);
});
