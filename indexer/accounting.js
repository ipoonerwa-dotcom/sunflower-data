"use strict";
/**
 * Performance accounting for SUNFLOWER, in USD fixed at the moment of purchase.
 *
 * One rule decides everything:
 *
 *     performance = the USD cost of the tokens an address bought and still holds
 *
 * "Still holds" counts what sits in the wallet plus what is pledged as collateral in the lending
 * vault, because pledging is a plain ERC20 transfer that would otherwise look like a sale.
 *
 * Writing it as one rule instead of a rule per event type is deliberate. Every case falls out:
 *
 *   sell            balance falls                       -> deducted
 *   transfer out    balance falls                       -> deducted  (this is what stops farming)
 *   pledge          balance falls, collateral rises     -> unchanged
 *   redeem          collateral falls, balance rises     -> unchanged
 *   default         collateral burns and never returns  -> deducted
 *   airdrop in      balance rises with no purchase      -> unchanged
 *   borrowed buy    an ordinary swap on the pair        -> added
 *
 * Why transfers must be deducted: if they were not, an address could buy for $10,000, move the
 * tokens to a second wallet, sell there, send the BNB back and buy again -- the same money
 * producing unlimited performance, for the price of the trading tax alone.
 *
 * Tokens that arrive without being bought carry no cost, and an outflow spends those first. That
 * keeps someone who was sent tokens and passed them on from losing performance they did earn,
 * without reopening the loop above: the loop needs bought tokens to leave, and they still do.
 *
 * This module is pure. It takes an ordered event stream and returns numbers, so the rules can be
 * tested without a network. All token amounts are BigInt in base units; USD is BigInt scaled by
 * USD_SCALE (1e18).
 */

const USD_SCALE = 10n ** 18n;

/** How long a purchase must be held for the referrer's reward. Selling inside it forfeits that part. */
const HOLD_SECONDS = 48 * 3600;

/**
 * A parcel of bought tokens and what it cost, in USD at the time of the buy.
 *
 * `amount` and `usd` are what is still held of it and shrink as it is sold; `bought` and `boughtUsd`
 * are what the purchase originally was and never change. Keeping both on one object is what lets a
 * report show "bought 1,000 on the 3rd, 400 still held" for every purchase, not just the totals.
 */
class Lot {
  constructor(amount, usd, meta = {}) {
    this.amount = amount;
    this.usd = usd;
    this.bought = amount;
    this.boughtUsd = usd;
    this.time = meta.time ?? 0; // unix seconds
    this.block = meta.block ?? 0;
    this.tx = meta.tx ?? "";
    this.bnb = meta.bnb ?? 0n; // what was paid, in wei
    this.source = meta.source ?? "swap"; // "swap" or "mint"
    // The team's view of the same purchase. `team` says whether it came after the buyer bound;
    // `teamCounted` is how much of it the team got (less any earlier post-binding sale it had to
    // make up for); `teamLeft` / `teamUsdLeft` are what of that is still held.
    this.team = false;
    this.teamCounted = 0n;
    this.teamLeft = 0n;
    this.teamUsdLeft = 0n;
    // How much of `teamCounted` left before the purchase was 48 hours old. That part earns the
    // referrer nothing; what was still held at 48 hours earned it, whatever happens afterwards.
    this.teamSoldEarly = 0n;
  }
}

class Account {
  constructor() {
    /** Bought tokens still held, oldest first. */
    this.lots = [];
    /** Every purchase ever made, oldest first, including those since sold down to nothing. */
    this.purchases = [];
    /** Tokens received without buying them. No cost, spent before bought ones. */
    this.giftBalance = 0n;
    /** Running totals, for display rather than for the rule. */
    this.boughtUsd = 0n;
    this.soldUsd = 0n;
    this.boughtTokens = 0n;
    this.soldTokens = 0n;
    this.staked = 0n;
    /** Principal in the 100-day staking contract, not yet released back. Still the member's. */
    this.locked = 0n;
    this.defaultedTokens = 0n;
    /** Post-binding purchases still counting for the team, oldest first. */
    this.teamLots = [];
    /** Tokens sold or sent away after binding beyond what the team ledger held: owed back first. */
    this.teamDebt = 0n;
  }

  /** The number this whole module exists to produce. */
  get performanceUsd() {
    let total = 0n;
    for (const lot of this.lots) total += lot.usd;
    return total;
  }

  /** What this address contributes to a team: its net buying since it bound, in USD at cost. */
  get teamPerformanceUsd() {
    let total = 0n;
    for (const lot of this.teamLots) total += lot.teamUsdLeft;
    return total;
  }

  get heldTokens() {
    let total = this.giftBalance;
    for (const lot of this.lots) total += lot.amount;
    return total;
  }
}

class Ledger {
  /**
   * @param {object} options
   * @param {Set<string>} options.excluded Addresses whose trades are protocol behaviour, not a
   *        member's: the lending vault's idle buybacks, the pair, the burn address.
   */
  constructor({ excluded = new Set() } = {}) {
    this.accounts = new Map();
    this.excluded = new Set([...excluded].map((a) => a.toLowerCase()));
    /** address -> where it bound, {block, index}: the moment its buying starts counting for a team. */
    this.bindings = new Map();
    /** Where in the chain the events being applied happened. The replay moves it per transaction. */
    this.clock = { block: 0, index: undefined, time: 0 };
  }

  /** Record where `address` joined the tree. Only purchases after this count for its team. */
  bind(address, { block, index }) {
    this.bindings.set(String(address).toLowerCase(), { block, index });
  }

  setClock(block, index, time = 0) {
    this.clock = { block, index, time };
  }

  /**
   * Whether events at the current clock come after `address` bound. Inside the binding's own block
   * the order of transactions decides, and where that order is unknown the answer is no: counting
   * a purchase the member may have made a moment before joining would be the wrong way to err.
   */
  afterBinding(address) {
    const bound = this.bindings.get(String(address).toLowerCase());
    if (!bound) return false;
    const { block, index } = this.clock;
    if (block !== bound.block) return block > bound.block;
    return index !== undefined && bound.index !== undefined && index > bound.index;
  }

  /**
   * A post-binding outflow, on the team's side of the books. The team's purchases go first, oldest
   * first; whatever they cannot cover becomes a debt that later purchases must repay before they
   * count. Without the debt, a member who already held a large position before binding could sell
   * it and buy it back, and the buy-back would land on the team as brand new performance.
   */
  _teamOut(a, tokens) {
    let remaining = tokens;
    while (remaining > 0n && a.teamLots.length > 0) {
      const lot = a.teamLots[0];
      const take = lot.teamLeft <= remaining ? lot.teamLeft : remaining;
      if (this.clock.time - lot.time < HOLD_SECONDS) lot.teamSoldEarly += take;
      if (take === lot.teamLeft) {
        lot.teamLeft = 0n;
        lot.teamUsdLeft = 0n;
        a.teamLots.shift();
      } else {
        const share = (lot.teamUsdLeft * take) / lot.teamLeft;
        lot.teamUsdLeft -= share;
        lot.teamLeft -= take;
      }
      remaining -= take;
    }
    a.teamDebt += remaining;
  }

  account(address) {
    const key = address.toLowerCase();
    if (!this.accounts.has(key)) this.accounts.set(key, new Account());
    return this.accounts.get(key);
  }

  isExcluded(address) {
    return this.excluded.has(String(address).toLowerCase());
  }

  /**
   * Tokens bought on the pair or minted. `usd` is the BNB spent valued at that block.
   * @param {{time?: number, block?: number, tx?: string, bnb?: bigint, source?: string}} meta
   */
  buy(address, tokens, usd, meta = {}) {
    if (this.isExcluded(address) || tokens <= 0n) return;
    const a = this.account(address);
    const lot = new Lot(tokens, usd, meta);
    a.lots.push(lot);
    a.purchases.push(lot);
    a.boughtTokens += tokens;
    a.boughtUsd += usd;

    if (this.afterBinding(address)) {
      // Repay what was sold since binding first; only the rest is new for the team.
      const repaid = tokens < a.teamDebt ? tokens : a.teamDebt;
      a.teamDebt -= repaid;
      lot.team = true;
      lot.teamCounted = tokens - repaid;
      lot.teamLeft = lot.teamCounted;
      lot.teamUsdLeft = (usd * lot.teamCounted) / tokens;
      if (lot.teamCounted > 0n) a.teamLots.push(lot);
    }
  }

  /** Tokens arriving any other way: a gift, an airdrop, a transfer between wallets. */
  receive(address, tokens) {
    if (this.isExcluded(address) || tokens <= 0n) return;
    this.account(address).giftBalance += tokens;
  }

  /**
   * Tokens leaving for good: sold, sent to someone else, or burned.
   * Gifted tokens go first, then bought ones oldest first.
   * @returns {bigint} the USD performance this removed.
   */
  release(address, tokens) {
    if (this.isExcluded(address) || tokens <= 0n) return 0n;
    const a = this.account(address);
    // The team's books move first and by their own rule: no gift buffer, nothing forgiven.
    if (this.afterBinding(address)) this._teamOut(a, tokens);
    let remaining = tokens;

    const fromGifts = remaining < a.giftBalance ? remaining : a.giftBalance;
    a.giftBalance -= fromGifts;
    remaining -= fromGifts;

    let removedUsd = 0n;
    while (remaining > 0n && a.lots.length > 0) {
      const lot = a.lots[0];
      if (lot.amount <= remaining) {
        removedUsd += lot.usd;
        remaining -= lot.amount;
        // Zeroed rather than just dropped: the same object sits in `purchases`, where it has to
        // read as "sold" from now on.
        lot.amount = 0n;
        lot.usd = 0n;
        a.lots.shift();
      } else {
        // Split the lot proportionally; the cost follows the tokens.
        const share = (lot.usd * remaining) / lot.amount;
        lot.usd -= share;
        lot.amount -= remaining;
        removedUsd += share;
        remaining = 0n;
      }
    }
    // Anything still unmatched was never ours to account for; ignore it rather than go negative.
    return removedUsd;
  }

  /** Sold on the pair. Deducts, and records the proceeds for display. */
  sell(address, tokens, usd) {
    const removed = this.release(address, tokens);
    if (!this.isExcluded(address) && tokens > 0n) {
      const a = this.account(address);
      a.soldTokens += tokens;
      a.soldUsd += usd;
    }
    return removed;
  }

  /** Collateral moving into the lending vault. Still theirs, so the ledger does not move. */
  pledge(address, tokens) {
    if (this.isExcluded(address) || tokens <= 0n) return;
    this.account(address).staked += tokens;
  }

  /** Collateral coming back out. */
  redeem(address, tokens) {
    if (this.isExcluded(address) || tokens <= 0n) return;
    const a = this.account(address);
    a.staked -= tokens > a.staked ? a.staked : tokens;
  }

  /** Tokens staked for 100 days. Like collateral, still the member's, so nothing else moves. */
  lock(address, tokens) {
    if (this.isExcluded(address) || tokens <= 0n) return;
    this.account(address).locked += tokens;
  }

  /** Staked principal released back to the member. */
  unlock(address, tokens) {
    if (this.isExcluded(address) || tokens <= 0n) return;
    const a = this.account(address);
    a.locked -= tokens > a.locked ? a.locked : tokens;
  }

  /** The 600-second window expired and the vault burned the collateral. It is really gone. */
  defaulted(address, tokens) {
    if (this.isExcluded(address) || tokens <= 0n) return 0n;
    const a = this.account(address);
    a.staked -= tokens > a.staked ? a.staked : tokens;
    a.defaultedTokens += tokens;
    return this.release(address, tokens);
  }

  /**
   * Apply one ordered event. Callers feed these in (blockNumber, logIndex) order.
   * @param {{type: string, address: string, tokens: bigint, usd?: bigint}} event
   */
  apply(event) {
    const usd = event.usd ?? 0n;
    switch (event.type) {
      case "buy":
        return this.buy(event.address, event.tokens, usd);
      case "sell":
        return this.sell(event.address, event.tokens, usd);
      case "receive":
        return this.receive(event.address, event.tokens);
      case "transferOut":
        return this.release(event.address, event.tokens);
      case "pledge":
        return this.pledge(event.address, event.tokens);
      case "redeem":
        return this.redeem(event.address, event.tokens);
      case "default":
        return this.defaulted(event.address, event.tokens);
      case "lock":
        return this.lock(event.address, event.tokens);
      case "unlock":
        return this.unlock(event.address, event.tokens);
      default:
        throw new Error("unknown event type: " + event.type);
    }
  }

  applyAll(events) {
    for (const event of events) this.apply(event);
    return this;
  }

  /** Personal performance, ignoring the team. */
  personalUsd(address) {
    const key = String(address).toLowerCase();
    return this.accounts.has(key) ? this.accounts.get(key).performanceUsd : 0n;
  }

  /** What `address` contributes to a team: net buying since it bound. */
  teamPerformanceUsd(address) {
    const key = String(address).toLowerCase();
    return this.accounts.has(key) ? this.accounts.get(key).teamPerformanceUsd : 0n;
  }

  /**
   * The team's performance: everyone's net buying since they bound, the address itself and
   * everyone below it, to unlimited depth. Purchases from before a member bound count for nobody.
   * @param {Map<string,string[]>} childrenOf lowercase address -> direct members
   */
  teamUsd(address, childrenOf) {
    let total = 0n;
    const stack = [String(address).toLowerCase()];
    const seen = new Set();
    while (stack.length) {
      const node = stack.pop();
      if (seen.has(node)) continue; // the registry forbids cycles, but never trust the input
      seen.add(node);
      total += this.teamPerformanceUsd(node);
      for (const child of childrenOf.get(node) ?? []) stack.push(child);
    }
    return total;
  }

  /**
   * Every account with something to show, largest first.
   *
   * Someone who bought and has since sold everything stays in, with their purchase history: a
   * referrer checking the 48-hour rule needs to see "bought, then sold", not an empty space.
   */
  ranking() {
    const desc = (x, y) => (y > x ? 1 : y < x ? -1 : 0);
    return [...this.accounts.entries()]
      .map(([address, a]) => ({
        address,
        // What the member shows as their performance: net buying since they bound.
        teamPerformanceUsd: a.teamPerformanceUsd,
        // Everything they hold at cost, bound or not. Kept for reconciliation, not for rewards.
        performanceUsd: a.performanceUsd,
        heldTokens: a.heldTokens,
        staked: a.staked,
        locked: a.locked,
        boughtUsd: a.boughtUsd,
        soldUsd: a.soldUsd,
        teamDebt: a.teamDebt,
        boundBlock: this.bindings.get(address)?.block ?? null,
        buys: a.purchases.map((lot) => ({
          t: lot.time,
          tx: lot.tx,
          src: lot.source,
          bnb: lot.bnb,
          usd: lot.boughtUsd,
          amt: lot.bought,
          left: lot.amount,
          team: lot.team,
          counted: lot.teamCounted,
          teamLeft: lot.teamLeft,
          early: lot.teamSoldEarly,
        })),
      }))
      .filter((row) => row.performanceUsd > 0n || row.heldTokens > 0n || row.buys.length > 0)
      .sort((x, y) => desc(x.teamPerformanceUsd, y.teamPerformanceUsd) || desc(x.performanceUsd, y.performanceUsd));
  }
}

const formatUsd = (value) => {
  const negative = value < 0n;
  const v = negative ? -value : value;
  const whole = v / USD_SCALE;
  const cents = ((v % USD_SCALE) * 100n) / USD_SCALE;
  return `${negative ? "-" : ""}$${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
};

module.exports = { Ledger, Account, Lot, USD_SCALE, HOLD_SECONDS, formatUsd };
