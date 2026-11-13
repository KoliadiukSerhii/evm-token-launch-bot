import assert from "node:assert/strict";
import { test } from "node:test";
import { monitorRetryDelayMs } from "./pool-monitor.js";

test("monitor retries wait 5s, 15s, 30s, then 60s", () => {
  assert.equal(monitorRetryDelayMs(1), 5_000);
  assert.equal(monitorRetryDelayMs(2), 15_000);
  assert.equal(monitorRetryDelayMs(3), 30_000);
  assert.equal(monitorRetryDelayMs(4), 60_000);
  assert.equal(monitorRetryDelayMs(20), 60_000);
});
