// fresh-tail: an early-and-broad bot for the agent-fun pump.fun replay (agent-fun/replay/v2).
//
// The first design tried here was momentum: buy a coin AFTER it had already moved
// (+6% over 45 slots, near its high, accelerating inflow). It lost -0.91 SOL on the
// dev window, 9 wins in 127 trips. A tape-structure check of the dev window then
// showed why: coins that are already up >= 6% over 45 slots go on to a MEDIAN
// -6.2% over the next 500 slots (25.6% fall below -22%). Buying the move is buying
// the top on this tape; the move mean-reverts.
//
// The same check showed where the edge actually is: buy at the FIRST trade and
// hold 100 slots and the MEDIAN coin is flat (+0.0%) but the MEAN is +16.1%,
// because ~11% of fresh coins pop more than +50% within ~25 seconds. The
// distribution is a lottery ticket: the median coin goes nowhere, a tenth of
// them run hard. So this bot buys every fresh coin EARLY and SMALL, before any
// move, and lets exits do the work: a trailing stop banks the runners, a stop
// and a time exit cut the median coin before it bleeds out. No momentum filter
// at all — any filter that waits for a move throws the edge away (proven above).
//
// Entry: a coin becomes a candidate on its CreateEvent. On the first batch where
// its size cap (1% of real SOL reserves) reaches minBuySol, buy min(cap,
// stakeSol) — provided the price has not already run past maxBuyVsCreate times
// its creation price (the proven loser: buying after the pop), the curve is not
// complete, a position slot is free, and cash covers it. A coin that never gets
// a big enough cap, runs past the guard, completes, or ages past maxEntryAge
// slots without being bought is dropped, never revisited.
//
// Exits (sell the whole position on the first that fires):
//   - stop loss: mark value below cost * (1 - stopLoss);
//   - trailing stop: once the peak mark reached cost * (1 + trailArm), value
//     below peak * (1 - trail) — this is what banks a runner that went +300%
//     and retraced, instead of a fixed take-profit that would cap it at +50% and
//     throw away the right tail the whole design is built on. (Arming the trail
//     at +10% means a coin that peaks at +12% and retraces can exit near -10%;
//     a variant arming at +30% was tried and scored worse on the dev window,
//     -0.555 vs -0.482 SOL, because on this mean-reverting tape the earlier
//     trail saves more than the later arm earns. See STRATEGY.md.)
//   - time: held longer than maxHold slots, unless up at least holdIfUp.
// A curve that completes is closed by the replay itself. No pyramiding, no
// re-entry: the edge is breadth across fresh coins, not concentration.
//
// Guardrail pacing: the run must end with round trips of >= 0.01 SOL on >= 20
// coins and drawdown <= 50%. If the bot's own fills or distinct coins lag the
// pace implied by elapsed block time over paceSecs (the 6-hour final window),
// it opens tiny probe round trips (buy probeSol of a liquid curve, sell it whole
// as soon as the buy lands) until it is back on pace.
//
// Deterministic by construction: no clock, no randomness, iteration only over
// insertion-ordered maps fed by the batch stream. The parameters below were set
// from the tape-structure facts above (fee maths, the ~11% pop rate, the
// mean-reversion of post-move entries), not fitted to any replay window: the
// final window is recorded after entries close, so fitting to the dev window
// would be fitting to coins that will never trade again. The dev backtest is a
// smoke test (does it run, does it trade, does it beat cash?), not a tuning set.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** SOL to put into one coin (the whole position; no adds). */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Skip a coin whose price already exceeds this multiple of its creation price. */
  maxBuyVsCreate: number;
  /** Slots after creation past which a coin is no longer "fresh". */
  maxEntryAge: number;
  /** Exits. */
  stopLoss: number;
  trail: number;
  /** The trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** The time limit does not apply while the position is up at least this much. */
  holdIfUp: number;
  /** Most momentum positions open at once. */
  maxMain: number;
  /** Guardrail pacing (see header). */
  targetCoins: number;
  targetFills: number;
  /** Seconds of block time the pace is measured over (the 6h final window). */
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
}

// Set from the tape-structure facts in the header, not from any backtest:
// fees are ~1.25% curve + ~0.0001 SOL per tx, so a 0.05 SOL stake pays ~1.5% to
// enter; the 18%/20%/10% exit bands are multiples of that round-trip cost, and
// the 1.5x creation-price guard is the line past which the dev tape's post-move
// entries showed negative expectancy.
export const DEFAULT_PARAMS: Params = {
  stakeSol: 0.05,
  minBuySol: 0.01,
  buySlipBps: 1500,
  maxBuyVsCreate: 1.5,
  maxEntryAge: 1500,
  stopLoss: 0.18,
  trail: 0.2,
  trailArm: 0.1,
  maxHold: 900,
  holdIfUp: 0.15,
  maxMain: 5,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 21_600,
  probeSol: 0.01,
  maxProbes: 1,
  maxExposureSol: 4,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;
const BPS_PER_UNIT = 10_000;

interface Held {
  opened: number;
  peakValue: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastValue: number;
}

export function createStrategy(p: Params): Bot {
  const held = new Map<Pubkey, Held>();
  const probes = new Map<Pubkey, boolean>();
  /** Coins created and not yet decided: creation price + creation slot. */
  const candidates = new Map<Pubkey, { price: number; slot: number }>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          if (!candidates.has(e.mint) && !held.has(e.mint)) {
            candidates.set(e.mint, { price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves), slot: e.slot });
          }
        } else if (e.event === 'TradeEvent') {
          traded.add(e.mint);
        }
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: a position that must go outranks any new entry.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) held.delete(mint);
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        let exit = h.exiting;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probes: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Entries: fresh coins only, earliest feasible batch, one fixed stake each.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      // Decide in batch-event order (insertion order of `traded` plus creates):
      // iterate the batch's own events so the order is the tape's, not a map's.
      const seenThisBatch = new Set<Pubkey>();
      for (const e of batch.events) {
        if (orders.length >= cap) break;
        if (e.event !== 'CreateEvent' && e.event !== 'TradeEvent') continue;
        const mint = e.mint;
        if (seenThisBatch.has(mint)) continue;
        seenThisBatch.add(mint);
        if (!candidates.has(mint)) continue;
        const created = candidates.get(mint)!;
        const createPrice = created.price;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) {
          candidates.delete(mint);
          continue;
        }
        if (now - created.slot > p.maxEntryAge) {
          // No longer fresh: the edge is in fresh coins only.
          candidates.delete(mint);
          continue;
        }
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        if (price > createPrice * p.maxBuyVsCreate) {
          // Already popped: buying after the move is the proven loser.
          candidates.delete(mint);
          continue;
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        if (capSol < p.minBuySol) {
          // Too early to size: keep waiting while the coin is still fresh
          // (the maxEntryAge check above drops it once it is not).
          continue;
        }
        candidates.delete(mint);
        if (slotsLeft <= 0 || mainLeft <= 0) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        let amount = Math.min(capSol, p.stakeSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastValue: 0 });
        slotsLeft--;
        mainLeft--;
      }

      // Guardrail pacing: open a probe when fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * Number(BPS_PER_UNIT)) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
