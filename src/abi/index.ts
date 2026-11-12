import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Abi, type Hex, parseAbi } from "viem";

export interface Artifact {
  contractName: string;
  abi: Abi;
  bytecode: Hex;
}

export function loadArtifact(name: string): Artifact {
  const path = resolve(process.cwd(), "contracts", "artifacts", `${name}.json`);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Artifact;
  } catch (error) {
    throw new Error(`artifact ${name} not found, run "npm run compile"`, {
      cause: error,
    });
  }
}

export const launchedEventAbi = parseAbi([
  "event Launched(address indexed token, address indexed pair, uint256 liquidity)",
]);

export const pairEventsAbi = parseAbi([
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
  "event Sync(uint112 reserve0, uint112 reserve1)",
  "event Mint(address indexed sender, uint256 amount0, uint256 amount1)",
  "event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)",
]);

export const pairReadAbi = parseAbi([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function totalSupply() view returns (uint256)",
]);

export const routerReadAbi = parseAbi([
  "function WETH() view returns (address)",
]);

export const priceFeedAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

export const routerLiquidityAbi = parseAbi([
  "function removeLiquidityETH(address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) returns (uint256 amountToken, uint256 amountETH)",
]);

export const routerSwapAbi = parseAbi([
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
]);
