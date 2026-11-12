export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface FeePolicy {
  priorityMultiplierPct: bigint;
  minPriorityFee: bigint;
  /** Multiplier on latest base fee for maxFeePerGas headroom. */
  baseFeeMultiplier: bigint;
}

export function computeEip1559Fees(
  baseFeePerGas: bigint | undefined,
  suggestedPriorityFee: bigint,
  policy: FeePolicy,
): Fees {
  const scaled =
    (suggestedPriorityFee * policy.priorityMultiplierPct) / 100n;
  const priority =
    scaled > policy.minPriorityFee ? scaled : policy.minPriorityFee;
  const base = baseFeePerGas ?? 0n;
  return {
    maxPriorityFeePerGas: priority,
    maxFeePerGas: base * policy.baseFeeMultiplier + priority,
  };
}
