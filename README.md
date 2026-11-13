# token-launch-bot

Бот запускає власний ERC-20 токен на Ethereum / Base / BNB Chain, одразу створює
V2-пул ліквідності на суму `POOL_USD` у нативній монеті мережі, моніторить пул
(купівлі, продажі, ліквідність) і керується через Telegram.

## Запуск

```bash
cp .env.example .env   # заповнити CHAINS, TOKENS, POOL_USD, PRIVATE_KEY, *_RPC_URLS, TELEGRAM_*
npm install
npm start              # компілює контракти і стартує бота
```

Docker: `docker compose up -d --build`. Логи — `logs/bot-YYYY-MM-DD.log`,
стан (деплої + курсор блоків) — `data/state.json`, черга — `data/tokens.json`.
**Не видаляйте `data/`**: без нього бот вважатиме токени незадеплоєними і запустить їх знову.

## Як працює запуск

На кожній мережі з `CHAINS` живе **один** токен. Мережі йдуть паралельно і не
чекають одна одну. Список `TOKENS` — це черга, однакова на старті для кожної
мережі (`data/tokens.json`).

1. Бот деплоїть перший символ, який на цій мережі ще не деплоївся.
2. Таймер `POOL_LIFETIME` (`Ns`/`Nm`/`Nh`/`Nd`, без суфікса це години) починається
   з моменту створення.
3. Коли час вийшов, бот продає токени з гаманця в пул, знімає всю свою LP
   (`removeLiquidityETH`) і ще раз продає токени, які повернулись із пулу, якщо
   в парі лишилась ліквідність. Нативка з пулу повертається зняттям LP.
4. Лише після повного виходу стартує пауза `DEPLOY_COOLDOWN` (за замовчуванням
   **1 година**), і тоді деплоїться наступний символ цієї мережі. Якщо вихід не
   вдався, повтор іде з паузою 5с → 10с → … до 5 хвилин, і наступний токен не стартує.

`/canceltimer` вимикає автовихід. `/deploy` без аргументів деплоїть наступний
символ на кожній вільній мережі. `/deploy SYMBOL` — цей символ на кожній.
`/deploy SYMBOL chain` — лише на одній.

Одна транзакція деплоїть одноразовий контракт `TokenLaunch`, конструктор якого:

1. створює `Token` (уся емісія мінтиться на `TokenLaunch`);
2. створює пару TOKEN/WETH (WBNB) у фабриці DEX або бере вже наявну;
3. переводить 100% емісії і `POOL_USD` у нативній монеті в пару;
4. мінтить LP-токени на гаманець деплоєра.

Між деплоєм токена і появою ліквідності немає жодного блоку, тож ніхто не встигне
створити пул раніше або вклинитись між кроками.

| Мережа   | DEX            | Ціна нативної монети |
| -------- | -------------- | -------------------- |
| ethereum | Uniswap V2     | Chainlink ETH/USD    |
| base     | Uniswap V2     | Chainlink ETH/USD    |
| bnb      | PancakeSwap V2 | Chainlink BNB/USD    |

## Telegram

`/status` `/balance` `/health` `/deploy [SYMBOL] [chain]` `/add_token <Name:SYMBOL[:supply]> [chain]`
`/set_token_order <SYMBOL>:<INDEX> [chain]` `/canceltimer <SYMBOL> [chain]`
`/sell_all [SYMBOL] [chain]` `/sell_tokens_in_percent <1-100> [chain]`
`/buy_tokens_in_sol <amount> [chain]`
`/mute` `/unmute` `/mute_exit_detail` `/unmute_exit_detail` `/stop` `/help`

`/buy_tokens_in_sol` купує живий токен за нативну монету мережі: ETH на Ethereum і
Base, BNB на BNB Chain. Мінімум 0.001. Якщо в `CHAINS` більше однієї мережі,
для купівлі й продажу мережу треба вказати.

`/sell_all` продає всю позицію тим самим виходом, що й таймер: спочатку весь
баланс токена з гаманця, потім знімає LP, потім продає токени, які повернулись
із пулу. Нативка повертається на гаманець деплоєра. Якщо живий токен один,
символ можна не писати. Якщо їх кілька — `/sell_all SYMBOL`, а коли той самий
символ живий на кількох мережах — ще й мережу. Після повного виходу стартує
пауза `DEPLOY_COOLDOWN`.

`/sell_tokens_in_percent` продає цей відсоток балансу токена і не чіпає решту.
Від 75% включно бот також закриває пул (аналог збору creator fees у pump-боті:
своєї окремої комісії творця тут немає, позиція бота — це LP) і продає токени,
які повернулись із пулу. Частина балансу, яку ця команда не продала, лишається
на гаманці.

Після створення пулу стартує таймер `POOL_LIFETIME` (за замовчуванням **24h**).
`/mute_exit_detail` ховає покрокові логи виходу. Повідомлення про помилку і
фінальне закриття лишаються.

Auto-shutdown tx (`approve`, `removeLiquidityETH`, продаж токена) використовують
**urgent gas**. Опційно задайте `*_WITHDRAW_RPC_URLS` (private/protected RPC) —
тоді ці tx не йдуть у публічний mempool через звичайні `*_RPC_URLS`.

Команди приймаються лише з чату `TELEGRAM_CHAT_ID` (група, канал або приватний
чат). Команди, надіслані поки бот не працював, при старті ігноруються.

## Структура

```
contracts/            Solidity: Token.sol, TokenLaunch.sol, interfaces/
scripts/compile.ts    solc → contracts/artifacts/*.json
src/
  app/main.ts         точка входу, сигнали, shutdown
  config/env.ts       парсинг і валідація env
  chains/<chain>/     модуль мережі: DEX, price feed, таймінги, політика газу
  evm/evm-client.ts   RPC (fallback, ws), газ, підпис, broadcast у всі RPC
  services/           token-launcher, pool-monitor, price-oracle
  domain/             типи і модель пулу
  storage/            data/state.json, data/tokens.json
  telegram/           клієнт Bot API і команди
  bot/                оркестратор, черга на кожну мережу, ChainRuntime, Reporter
```

Нова мережа = нова папка в `src/chains/` + рядок у `chains/registry.ts` і
`CHAIN_KEYS`.
