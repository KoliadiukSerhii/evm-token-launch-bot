import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseGwei } from "viem";
import { CHAINS } from "./registry.js";
import { CHAIN_KEYS } from "./types.js";
import { computeEip1559Fees } from "../evm/fees.js";

describe("withdraw fee policy per chain", () => {
  for (const key of CHAIN_KEYS) {
    it(`${key}: urgent fees are at least as aggressive as normal`, () => {
      const cfg = CHAINS[key].fees;
      const base = parseGwei("10");
      const suggested = parseGwei("0.3");
      const normal = computeEip1559Fees(base, suggested, {
        priorityMultiplierPct: cfg.priorityMultiplierPct,
        minPriorityFee: cfg.minPriorityFee,
        baseFeeMultiplier: 2n,
      });
      const urgent = computeEip1559Fees(base, suggested, {
        priorityMultiplierPct: cfg.withdrawPriorityMultiplierPct,
        minPriorityFee: cfg.withdrawMinPriorityFee,
        baseFeeMultiplier: cfg.withdrawBaseFeeMultiplier,
      });
      assert.ok(
        urgent.maxPriorityFeePerGas >= normal.maxPriorityFeePerGas,
        "priority fee",
      );
      assert.ok(urgent.maxFeePerGas >= normal.maxFeePerGas, "max fee");
    });
  }
});
