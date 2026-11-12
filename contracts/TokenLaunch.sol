// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Token} from "./Token.sol";
import {IUniswapV2Factory, IUniswapV2Pair, IUniswapV2Router02, IWETH} from "./interfaces/IUniswapV2.sol";

contract TokenLaunch {
    event Launched(address indexed token, address indexed pair, uint256 liquidity);

    constructor(string memory name_, string memory symbol_, uint256 supply, address router) payable {
        IUniswapV2Router02 dex = IUniswapV2Router02(router);
        IUniswapV2Factory factory = IUniswapV2Factory(dex.factory());
        address wrapped = dex.WETH();

        Token token = new Token(name_, symbol_, supply);

        address pair = factory.getPair(address(token), wrapped);
        if (pair == address(0)) pair = factory.createPair(address(token), wrapped);

        token.transfer(pair, supply);
        IWETH(wrapped).deposit{value: msg.value}();
        IWETH(wrapped).transfer(pair, msg.value);
        uint256 liquidity = IUniswapV2Pair(pair).mint(msg.sender);

        emit Launched(address(token), pair, liquidity);
    }
}
