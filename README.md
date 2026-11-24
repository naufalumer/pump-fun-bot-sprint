# fresh-tail — Pump.fun Bot Sprint entry

A trading bot for pump.fun-style Solana bonding curves, built for the
[make.fun](https://make.fun) competition
`u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed`
(harness `pumpfun-replay/v2`, paper money, 10 SOL starting capital).

## Idea

Fresh pump.fun coins are a lottery ticket with a visible payoff shape: buy at
the first trade and hold ~100 slots and the *median* coin is flat (+0.0%) but
the *mean* is +16.1%, because ~11% of fresh coins pop more than +50% within
~25 seconds. The edge is the right tail — so the bot buys **every fresh coin
early and small**, before any move, and lets exits do the work. No momentum
filter: a first version that bought only after a +6% move lost −0.91 SOL on the
dev window, and a tape check showed why (coins already up ≥ 6% go on to a
median −6.2% over the next 500 slots — buying the move is buying the top).

- **Entry:** on a coin's CreateEvent; buy on the first batch where its size cap
  (1% of real SOL reserves) reaches 0.01 SOL, fixed 0.05 SOL — provided the
  price has not already run past 1.5x its creation price, the curve is not
  complete, a position slot is free, and cash covers it. Coins that never get a
  big enough cap, run past the guard, complete, or age past 1500 slots are
  dropped, never revisited. One entry per coin, ever; no pyramiding.
- **Exits (sell all, first one that fires):** stop-loss −18% vs cost; trailing
  stop −20% from peak once peak ≥ +10% (this banks a runner that went +300%
  and retraced, instead of a fixed take-profit that would cap it at +50% and
  throw away the tail the design is built on); time exit after 900 slots
  unless up ≥ 15%.
- **Guardrail pacing:** if fills or distinct coins lag the pace implied by
  elapsed block time over the 6-hour final window, tiny 0.01 SOL probe round
  trips keep the run above the ≥ 20-coin / ≥ 0.01 SOL round-trip bar.

Full rationale, tape evidence and parameter provenance: see
[STRATEGY.md](STRATEGY.md).

## Layout

| File | What it is |
|---|---|
| `main.ts` | Entrypoint the grader runs (`node /bot/main.ts`). |
| `strategy.ts` | The strategy. Written fresh for this competition; no sweep, no tuning. |
| `vendor/agentfun-bot.ts` | The kit's bot SDK shim, vendored byte for byte (excluded from authorship counts). |
| `tools/sim.ts`, `tools/backtest.ts` | Kit-provided local replay engine + backtest runner (dev tooling only; the grader never imports them). |
| `LICENSE` | MIT. |
| `.makefun/owner.json` | Payout wallet for the entry. |

## Local check (practice replay)

The kit's dev window (24 h of pump.fun events, 2 Nov 2026, 1,222 mints) ships
in the kit tarball; it is a practice replay only — the final window is recorded
after entries close, so no parameter was fitted to it.

```sh
# fast offline backtest with the kit's local engine port
node tools/backtest.ts <kit dir>

# the server's own grader path, unisolated (no Docker on this machine)
node <kit>/cli/makefun.mjs grade-local --kit <kit dir> --bot . --driver process
```

## Status

Built, backtested, and graded locally with the server's own grader
(`grade-local --driver process`, full dev window): **net PnL −1.371 SOL**
(910 fills, 433 coins, 455 trips, 13.2% win rate, max drawdown 14.4%,
guardrails met, 90% interval −1.70 .. −1.07 SOL; two executions reproduced
byte for byte). That is far better than the house pilot momentum bot on the
same window (−9.460 SOL, drawdown guardrail failed) — but it does **not** beat
holding cash on the dev window, and the entry is reported as such. See
[STRATEGY.md](STRATEGY.md) for the full validation history.

**Not submitted.** Paper money only; no real funds, no network access at run
time, no secrets.
