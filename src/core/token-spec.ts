import { type TokenSpec } from "../domain/types.js";

const DEFAULT_SUPPLY = 1_000_000_000n;

export function parseTokenEntry(entry: string): TokenSpec {
  const [name = "", symbol = "", supplyRaw] = entry
    .split(":")
    .map((part) => part.trim());
  if (!name || !/^[A-Za-z0-9]{1,16}$/.test(symbol)) {
    throw new Error(
      `"${entry}" must look like "Name:SYMBOL" or "Name:SYMBOL:supply"`,
    );
  }
  if (supplyRaw !== undefined && !/^[1-9]\d*$/.test(supplyRaw)) {
    throw new Error(`supply of ${symbol} must be a positive integer`);
  }
  return {
    name,
    symbol: symbol.toUpperCase(),
    supply: supplyRaw === undefined ? DEFAULT_SUPPLY : BigInt(supplyRaw),
  };
}
