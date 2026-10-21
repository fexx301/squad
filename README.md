<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/squad-logo-white.svg">
    <img src="public/squad-logo.svg" alt="Squad" width="320">
  </picture>
</p>

# Squad — copy a trade, not a trader

Squad lets a Telegram group trade [Strike](https://strikefinance.org) perps together. When a member opens a position from the chat, a card posts to the group. Anyone in the group can copy **that one trade** at their own size with one tap. When the original trader exits, copies close with them (or ask first), and every copy carries its own stop-loss.

Built for the Strike Hackathon (Oct 21–23, 2026). Runs on Strike **testnet**.

- Bot: [@strike_squad_bot](https://t.me/strike_squad_bot)
- Wallet connect page: https://strikesquad.duckdns.org/connect (opened from a one-time link the bot sends)

## Why

Today a trading group shares a call in chat and everyone re-enters it by hand, then watches the chat for the exit. Strike's native copy trading is the other option: an ongoing subscription to *everything* a trader does, set up in the app, with a 10% profit share. Squad sits in between:

| | Re-enter by hand | Native copy subscription | Squad |
|---|---|---|---|
| Choose which trades to follow | yes | no, all fills | yes, per trade |
| Your own size per trade | yes | ratio or fixed amount | yes, per tap |
| Exit follows the trader | no, watch the chat | yes | yes (or "ask me") |
| Stop-loss | manual | a USD loss limit that ends the whole subscription | a stop order on each copy |
| Where it happens | app + chat | app | the group chat |

Prior art: [pvp.trade](https://docs.pvp.trade) built group trading in Telegram on Hyperliquid, including copy and countertrade subscriptions. Squad brings the model to Strike with three Strike-specific differences: Cardano wallets sign in directly; the bot's key can trade but Strike locks withdrawals to the member's own wallet; and the group's builder code collects the builder fee natively.

## How it uses Strike

- **Builder Connect** (`/auth/builder/request-signature`, `/verify-signature`): a member signs one challenge with a Cardano CIP-30 wallet (Lace, Eternl…). Strike creates the account if needed, plus a trading-only API wallet bound to the builder code. Funds are deposited the usual way (we used the testnet app's Cardano deposit).
- **Builder codes**: every Squad order carries `X-Builder-Fee-Bps: 10` for the builder code `squad`. Strike validates it on submit (a 50 bps header is rejected: *"exceeds builder max of 10"*). After the first test session, the Builder Codes dashboard showed **$149.79 attributed volume and $0.06 earned** on a builder account that never traded.
- **Orders**: market entries and reduce-only exits on `/v2/order`, confirmed by reading the order back (writes are asynchronous). Each copy also gets a reduce-only `stop` order. Strike cancels it automatically when the position closes (`position_closed`).
- **Reads**: `/v2/markets` (size step, tick, minimum notional, price bounds), `/price/v2/markPrice`, `/v2/positions`, `/v2/history/fill` (VWAP entry for the stop).

## Commands

| Where | Command | What it does |
|---|---|---|
| DM | `/connect` | One-time link (30 min) to sign with your Cardano wallet |
| Group | `/long ETH 25`, `/short ETH 25` | Open a position worth ~$25 and post a copy card |
| Group | `/close` | Close your latest Squad trade; copies close or are asked |
| Any | `/exits follow` \| `/exits ask` | Copies close with the lead, or you get a Close/Keep prompt |
| Any | `/stop 3` | Stop-loss distance for your copies, % from your entry (1–10) |

Card buttons: **Copy $25 / $50 / $100**.

## Safety rules (enforced in code, unit-tested)

- One tap = one copy. The copy record is written before the order, so a double tap cannot double-place.
- A card older than 15 minutes, or for a trade the lead already closed, cannot be copied.
- Strike positions are one-way net per market, so a copy is refused if you already hold that market. Squad can then close exactly what it opened.
- Closes are reduce-only, for `min(copied fill, live position)`, so they can never flip a position or touch unrelated size.
- Trust model: the server holds each member's Builder Connect API-wallet key. That key can place trades, but withdrawals are locked by Strike to the wallet that signed in. Copy sizes and stops are enforced by Squad, not by the wallet.

## Testnet notes (disclosed)

- **Liquidity is ours.** Strike testnet marks track mainnet, but its order books are stale: SOL and BTC sell quotes sit far below the mark, ADA has a minimum order price of $10 against a ~$0.23 mark, and orders more than 5% from the mark are rejected. A fourth account we control (**Maker**) rests a post-only bid and ask ±0.2% around the ETH mark, so trades fill. Squad therefore offers **ETH-USD only** on testnet.
- Filled orders read back without their `Builder` field, and the fill `fee` shows only Strike's base rate. Builder earnings are visible on the Builder Codes dashboard. We show those numbers rather than our own fee math.

## Run it

Node 24, no dependencies.

```bash
cp .env.example .env   # add TELEGRAM_BOT_TOKEN and BUILDER_CODE
npm test               # 10 unit tests
npm start              # bot + connect page (localhost:8787) + testnet Maker
```

The first start prints a link to connect the Maker wallet. Members DM the bot `/connect`.

Deployment (AWS EC2, Caddy HTTPS, secrets in SSM Parameter Store, no inbound SSH): see `deploy/`.

## Layout

```
src/strike.js   Ed25519 request signing, Builder Connect
src/connect.js  one-time links → challenge → CIP-30 signature → API wallet
src/copy.js     lead trades, copies, follow/ask exits, stop-loss
src/maker.js    testnet liquidity (disclosed)
src/bot.js      Telegram Bot API (long polling, no SDK)
public/         wallet connect page, bech32 encoder
```
