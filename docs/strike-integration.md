# Strike integration and testnet evidence

Supporting detail for the [README](../README.md): the exact Strike calls Squad makes, and what we measured on testnet.

## Calls Squad makes

- **Builder Connect** (`/auth/builder/request-signature`, then `/auth/builder/verify-signature`):
  - A member signs one challenge with a Cardano CIP-30 wallet (Lace, Eternl…).
  - Strike creates the account if needed, plus a trading-only API wallet bound to the builder code.
  - Only verify revokes the member's earlier keys, so an abandoned link changes nothing.
- **Builder codes:** every Squad order carries `X-Builder-Fee-Bps: 10` for the builder code `squad`.
  - Strike validates the header on submit: a 50 bps header is rejected with *"exceeds builder max of 10"*.
  - Strike reads it on order, batch and strategy submits (not on grid, TWAP or copy orders).
- **Orders:**
  - Market entries and reduce-only exits go to `/v2/order`.
  - Writes are asynchronous (201 = accepted), so Squad confirms each order by reading it back.
  - Each copy also gets a reduce-only `stop` order. Strike cancels it automatically when the position closes (`position_closed`).
- **Reads:**
  - `/v2/markets` for size step, tick, minimum notional and price bounds.
  - `/price/v2/markPrice` for the mark.
  - `/v2/positions` (public with `?account_id=`) for the exit watcher.
  - `/v2/history/fill` for VWAP entries, stop prices and realized P&L.

## Testnet observations

- **Liquidity:** testnet marks track mainnet, but the order books are stale.
  - SOL and BTC sell quotes sit far below the mark.
  - ADA has a minimum order price of $10 against a ~$0.23 mark.
  - Orders more than 5% from the mark are rejected.
  - A fourth account we control (**Maker**, `src/maker.js`) rests a post-only bid and ask ±0.2% around the ETH mark, so trades fill. Squad therefore offers ETH-USD only on testnet.
- **Builder fee visibility:** filled orders read back without their `Builder` field, and the fill `fee` shows only Strike's base rate.
  - Builder earnings appear on the Builder Codes dashboard. On Oct 21 it showed $149.79 attributed volume and $0.06 earned, on a builder account that never traded.
  - We report the dashboard's numbers rather than our own fee math.

## Evidence for the demonstrated results

- **Exit followed from the Strike app (Oct 22, 11:58 Lagos, UTC+1).** Strike's public trade tape (`GET /price/v2/trades?symbol=ETH-USD`) shows:
  - the lead's close at 11:58:42.459 (trade 18255, sell 0.01 @ 2397.76);
  - the copy's reduce-only close at 11:58:46.503 (trade 18256), 4.0 s later.
- **Stop order:** a copy with a 0.5% stop triggered at 2475.90 and filled at 2471.54. Squad reported the real fill (−$0.17, before fees).
- **Ask mode:** the lead's `/close` sent the copier a Close/Keep prompt. Close filled 0.01, and Strike auto-cancelled the copy's stop.
