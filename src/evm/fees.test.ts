import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseGwei } from "viem";
import { computeEip1559Fees, type FeePolicy } from "./fees.js";

const normal: FeePolicy = {
  priorityMultiplierPct: 150n,
  minPriorityFee: parseGwei("0.2"),
  baseFeeMultiplier: 2n,
};

const urgent: FeePolicy = {
  priorityMultiplierPct: 300n,
  minPriorityFee: parseGwei("1"),
  baseFeeMultiplier: 3n,
};

describe("computeEip1559Fees", () => {
  it("uses multiplier when suggestion is high enough", () => {
    const fees = computeEip1559Fees(parseGwei("10"), parseGwei("2"), normal);
    assert.equal(fees.maxPriorityFeePerGas, parseGwei("3"));
    assert.equal(fees.maxFeePerGas, parseGwei("10") * 2n + parseGwei("3"));
  });

  it("uses min priority when suggestion is low", () => {
    const fees = computeEip1559Fees(parseGwei("5"), 1n, normal);
    assert.equal(fees.maxPriorityFeePerGas, parseGwei("0.2"));
  });

  it("urgent policy beats normal for the same suggestion", () => {
    const suggested = parseGwei("0.5");
    const base = parseGwei("20");
    const regular = computeEip1559Fees(base, suggested, normal);
    const fast = computeEip1559Fees(base, suggested, urgent);
    assert.ok(fast.maxPriorityFeePerGas > regular.maxPriorityFeePerGas);
    assert.ok(fast.maxFeePerGas > regular.maxFeePerGas);
  });

  it("handles missing base fee (legacy edge)", () => {
    const fees = computeEip1559Fees(undefined, parseGwei("1"), urgent);
    assert.equal(fees.maxPriorityFeePerGas, parseGwei("3"));
    assert.equal(fees.maxFeePerGas, parseGwei("3"));
  });
});
