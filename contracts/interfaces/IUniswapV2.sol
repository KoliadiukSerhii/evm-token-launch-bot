// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IUniswapV2Router02 {
    function factory() external view returns (address);
    function WETH() external view returns (address);
}

interface IUniswapV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address);
    function createPair(address tokenA, address tokenB) external returns (address);
}

interface IUniswapV2Pair {
    function mint(address to) external returns (uint256 liquidity);
}

interface IWETH {
    function deposit() external payable;
    function transfer(address to, uint256 value) external returns (bool);
}
