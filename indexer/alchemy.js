"use strict";
/**
 * Fetching the history from Alchemy without ever calling eth_getLogs over a wide range.
 *
 * Measured, because every free option had to be ruled out first:
 *   - Etherscan's free plan does not cover BSC at all
 *   - sixteen free RPCs either refuse eth_getLogs, serve only recent blocks, or cap it at 50
 *   - Alchemy's free plan caps eth_getLogs at a 10-block range, which is 134,000 calls here
 *
 * But `alchemy_getAssetTransfers` is not subject to that cap, and archive `eth_call` works. So the
 * whole history -- 18,685 transfers across 6,082 addresses -- comes down in 28 calls, and prices
 * are read straight from the Chainlink feed at the block each trade happened in.
 *
 * Everything is shaped into the same log objects the tested replay already understands, so the
 * accounting is not touched by where the data came from.
 */

const fs = require("fs");
const path = require("path");
const { id } = require("ethers");

const TOPIC_TRANSFER = id("Transfer(address,address,uint256)");
const TOPIC_SWAP = id("Swap(address,uint256,uint256,uint256,uint256,address)");
const TOPIC_BORROW_STARTED = id("BorrowStarted(address,uint256,uint256,uint256,uint256)");
const TOPIC_REPAID = id("RepaidAndUnstaked(address,uint256,uint256)");
const TOPIC_DEFAULTED = id("Defaulted(address,address,uint256,uint256)");
const TOPIC_MINTED = id("Minted(address,uint256,uint256)");
const TOPIC_BOUND = id("Bound(address,address)");
const TOPIC_STAKED = id("Staked(address,uint256,uint256,uint256)");
const TOPIC_CLAIMED = id("Claimed(address,uint256)");

/**
 * The deployed token carves a couple of wei out of every transfer that is not a buy and scatters
 * them to random addresses (config.airdropNumbs, 2 today, capped at 10 by its setter). A payout
 * therefore reaches the wallet slightly short of what the paying contract sent.
 */
const DUST_TOLERANCE = 10n;
const CHAINLINK_BNB_USD = "0x0567f2323251f0aab15c8dfb1967e4e8a7d42aee";
const LATEST_ROUND_DATA = "0xfeaf968c";

const pad = (address) => address.toLowerCase().replace("0x", "").padStart(64, "0");
const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const secondsOf = (transfer) => {
  const ms = Date.parse(transfer.metadata?.blockTimestamp ?? "");
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
};
const hex = (n) => "0x" + n.toString(16);
const blockOf = (transfer) => parseInt(transfer.blockNum, 16);

/**
 * What earlier runs already read, kept on disk so that a run only asks the chain for what is new.
 * Run every quarter of an hour, a full re-read would spend Alchemy's free monthly allowance in about
 * a week; reading only the new blocks costs a few dozen requests.
 *
 * Only settled history is kept. Anything within FINAL_MARGIN blocks of the head a run read up to is
 * asked again by the next run, so a reorganised tip can never stick. BSC finalises within a couple
 * of blocks; the margin is many times that.
 */
const FINAL_MARGIN = 50;

class DiskCache {
  /** @param {string|null} dir where to keep the files; null keeps nothing, and every run reads everything */
  constructor(dir) {
    this.dir = dir;
    if (dir) fs.mkdirSync(dir, { recursive: true });
  }

  read(name, fallback) {
    if (!this.dir) return fallback;
    const file = path.join(this.dir, name + ".json");
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
  }

  /** Written aside and renamed into place, so an interrupted run never leaves half a file behind. */
  write(name, value) {
    if (!this.dir) return;
    const file = path.join(this.dir, name + ".json");
    fs.writeFileSync(file + ".tmp", JSON.stringify(value));
    fs.renameSync(file + ".tmp", file);
  }
}

const NO_CACHE = new DiskCache(null);

/** Only the fields the replay reads, which keeps the cache a fraction of what Alchemy returns. */
const compact = (t) => ({
  blockNum: t.blockNum,
  hash: t.hash,
  from: t.from,
  to: t.to,
  rawContract: { value: t.rawContract?.value ?? null },
  metadata: { blockTimestamp: t.metadata?.blockTimestamp ?? null },
});

/**
 * Every transfer matching `filter` up to `head`, asking Alchemy only for the blocks after the
 * settled part an earlier run kept. The result is in chain order either way: the kept part ends
 * on a block boundary and the fresh part starts on the next block. Without a head, everything up
 * to "latest" is read and nothing is kept.
 */
async function transfersUpTo(alchemy, cache, name, filter, head) {
  if (head === undefined) return alchemy.transfers(filter);
  const key = JSON.stringify(filter);
  const saved = cache.read("transfers-" + name, null);
  // A cache taken further along than this run, or for another query, is of no use here.
  const usable = saved !== null && saved.key === key && saved.final <= head;
  const kept = usable ? saved.items : [];
  const from = usable ? saved.final + 1 : 0;
  const fresh = from <= head ? (await alchemy.transfers({ ...filter, fromBlock: hex(from), toBlock: hex(head) })).map(compact) : [];
  const all = [...kept, ...fresh];
  const final = head - FINAL_MARGIN;
  if (!usable || final > saved.final) {
    cache.write("transfers-" + name, { key, final, items: all.filter((t) => blockOf(t) <= final) });
  }
  return all;
}

class Alchemy {
  constructor(url, { concurrency = Number(process.env.RPC_CONCURRENCY || 5) } = {}) {
    if (!url) throw new Error("RPC_URL is not set");
    this.url = url;
    this.concurrency = concurrency;
    this.calls = 0;
    this.byMethod = {}; // what a run cost, method by method: the free plan is metered per method
    this.nextId = 1;
    /** When the plan is being throttled, every worker waits -- see rpc(). */
    this.pausedUntil = 0;
    this.throttled = 0;
  }

  async rpc(method, params, { retries = 9 } = {}) {
    for (let attempt = 0; ; attempt++) {
      // A per-request backoff is not enough: the rate limit is on the plan, not the request, so one
      // worker sleeping while the others keep hammering never clears it. The cooldown is shared.
      const wait = this.pausedUntil - Date.now();
      if (wait > 0) await sleep(wait);

      this.calls++;
      this.byMethod[method] = (this.byMethod[method] ?? 0) + 1;
      try {
        const response = await fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
        });
        // A throttled free plan answers with an empty body or an HTML page, not JSON, so the text
        // is read first: `response.json()` on those throws "Unexpected end of JSON input", which
        // says nothing about the real problem.
        const text = await response.text();
        if (!response.ok || !text.startsWith("{")) {
          throw new Error(`HTTP ${response.status}: ${text.slice(0, 80) || "(empty body)"}`);
        }
        const body = JSON.parse(text);
        if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
        return body.result;
      } catch (error) {
        if (attempt >= retries) throw error;
        const cooldown = Math.min(600 * 2 ** attempt, 20_000);
        this.pausedUntil = Math.max(this.pausedUntil, Date.now() + cooldown);
        this.throttled++;
      }
    }
  }

  async blockNumber() {
    return parseInt(await this.rpc("eth_blockNumber", []), 16);
  }

  /** Every matching ERC20 transfer, following pageKey to the end. */
  async transfers(filter) {
    const out = [];
    let pageKey;
    do {
      const result = await this.rpc("alchemy_getAssetTransfers", [{
        fromBlock: "0x0",
        toBlock: "latest",
        category: ["erc20"],
        excludeZeroValue: false,
        // The block timestamp rides along for free here, where reading it per block would cost a
        // call each. Buy times drive the 48-hour holding check and the daily figures.
        withMetadata: true,
        maxCount: "0x3e8",
        order: "asc",
        ...(pageKey ? { pageKey } : {}),
        ...filter,
      }]);
      out.push(...result.transfers);
      pageKey = result.pageKey;
    } while (pageKey);
    return out;
  }

  /** Runs jobs a few at a time, reporting progress on one line. */
  async pool(items, worker, label) {
    const results = new Array(items.length);
    let next = 0;
    let done = 0;
    const runners = Array.from({ length: Math.min(this.concurrency, items.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
        if (++done % 200 === 0 || done === items.length) {
          process.stdout.write(`\r  ${label} ${done}/${items.length}`);
        }
      }
    });
    await Promise.all(runners);
    if (items.length >= 200) process.stdout.write("\r" + " ".repeat(60) + "\r");
    return results;
  }
}

/**
 * BNB/USD at the exact block of every trade, read from Chainlink through archive state.
 * Cached on disk: the answer for a past block never changes, so a rerun costs nothing.
 */
class PriceOracle {
  constructor(alchemy, cacheFile = path.join(__dirname, "..", ".price-cache.json")) {
    this.alchemy = alchemy;
    this.cacheFile = cacheFile;
    this.cache = new Map();
    if (fs.existsSync(cacheFile)) {
      for (const [block, usd] of Object.entries(JSON.parse(fs.readFileSync(cacheFile, "utf8")))) {
        this.cache.set(Number(block), BigInt(usd));
      }
    }
  }

  async warm(blocks) {
    const missing = [...new Set(blocks)].filter((b) => !this.cache.has(b)).sort((a, b) => a - b);
    if (missing.length === 0) return;
    console.log(`  reading BNB/USD at ${missing.length} blocks (cached after this)`);
    await this.alchemy.pool(missing, async (block) => {
      const raw = await this.alchemy.rpc("eth_call", [
        { to: CHAINLINK_BNB_USD, data: LATEST_ROUND_DATA },
        "0x" + block.toString(16),
      ]);
      // latestRoundData returns (roundId, answer, startedAt, updatedAt, answeredInRound); the feed
      // reports 8 decimals, scaled here to 18 so all USD maths stays in one unit.
      const answer = BigInt("0x" + raw.slice(2).slice(64, 128));
      this.cache.set(block, answer * 10n ** 10n);
      if (this.cache.size % 500 === 0) this.save(); // checkpoint, so a blip costs minutes not hours
    }, "prices");
    this.save();
  }

  save() {
    const plain = {};
    for (const [block, usd] of this.cache) plain[block] = usd.toString();
    fs.writeFileSync(this.cacheFile, JSON.stringify(plain));
  }

  /** The price at `block`, falling back to the nearest earlier one that is known. */
  at(block) {
    if (this.cache.has(block)) return this.cache.get(block);
    let best = 0n;
    let bestBlock = -1;
    for (const [known, usd] of this.cache) {
      if (known <= block && known > bestBlock) {
        bestBlock = known;
        best = usd;
      }
    }
    return best;
  }
}

/**
 * Reads logs at a known set of blocks, which is what makes a 10-block eth_getLogs cap workable.
 *
 * Nothing is scanned blindly. The candidate blocks come from the transfers, and an event that moves
 * tokens cannot occur in a block where no tokens moved, so the set is complete by construction --
 * and only logs at candidate blocks are returned, whatever else a window happened to cover, so the
 * answer does not depend on how the blocks were grouped into windows on a given run.
 *
 * With a cache and a head, settled blocks are kept per block, the empty ones included, and never
 * asked for again.
 */
async function logsAtBlocks(alchemy, address, topics, blocks, label, { cache = NO_CACHE, head, span = 10 } = {}) {
  const wanted = [...new Set(blocks)].sort((a, b) => a - b);
  if (wanted.length === 0) return [];

  const name = "logs-" + label;
  const key = JSON.stringify([address.toLowerCase(), topics]);
  const saved = cache.read(name, null);
  const byBlock = saved !== null && saved.key === key ? saved.byBlock : {};
  const missing = wanted.filter((block) => !(block in byBlock));

  const windows = [];
  for (const block of missing) {
    const last = windows[windows.length - 1];
    if (last && block - last.from < span) last.to = block;
    else windows.push({ from: block, to: block });
  }

  const results = await alchemy.pool(
    windows,
    (window) =>
      alchemy.rpc("eth_getLogs", [{
        address,
        topics,
        fromBlock: hex(window.from),
        toBlock: hex(window.to),
      }]),
    label
  );
  const fetched = new Map(missing.map((block) => [block, []]));
  for (const log of results.flat()) fetched.get(parseInt(log.blockNumber, 16))?.push(log);

  if (head !== undefined) {
    const settled = [...fetched].filter(([block]) => block <= head - FINAL_MARGIN);
    for (const [block, logs] of settled) byBlock[block] = logs;
    if (settled.length) cache.write(name, { key, byBlock });
  }
  return wanted
    .flatMap((block) => byBlock[block] ?? fetched.get(block) ?? [])
    .sort(
      (a, b) =>
        parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16) ||
        parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16)
    );
}

/** Reshapes a real log into the stream entry the replay reads, tagged with what it means. */
const asStream = (kind, offset) => (log) => ({
  kind,
  blockNumber: String(parseInt(log.blockNumber, 16)),
  transactionHash: log.transactionHash,
  // Left at zero so every synthesised stream sorts the same way: within a block the grouping then
  // falls back to the order the transfers arrived in, which is chain order.
  transactionIndex: "0",
  logIndex: String(offset + parseInt(log.logIndex, 16)),
  topics: log.topics,
  data: log.data,
});

/**
 * Pulls the whole history and returns it as the log streams the replay expects.
 *
 * Only the fields the replay reads are filled in. A synthesised Swap carries the BNB legs and
 * nothing else, because the token amounts come from the transfers themselves -- which is also what
 * makes the result immune to the token's buy tax moving the same tokens twice.
 */
async function fetchHistory(alchemy, config, { cache = NO_CACHE, head } = {}) {
  const { token, pair, wbnb, lendingVault } = config;
  const settledOnly = { cache, head };

  console.log("  fetching transfers…");
  const [tokenTransfers, bnbIn, bnbOut] = await Promise.all([
    transfersUpTo(alchemy, cache, "token", { contractAddresses: [token] }, head),
    transfersUpTo(alchemy, cache, "bnb-in", { contractAddresses: [wbnb], toAddress: pair }, head),
    transfersUpTo(alchemy, cache, "bnb-out", { contractAddresses: [wbnb], fromAddress: pair }, head),
  ]);

  // rawContract.value is the exact hex; `value` is a float and loses precision at 18 decimals.
  const exact = (t) => BigInt(t.rawContract?.value ?? "0x0");

  const transfer = tokenTransfers.map((t, i) => ({
    kind: "transfer",
    blockNumber: String(parseInt(t.blockNum, 16)),
    timeStamp: secondsOf(t),
    transactionHash: t.hash,
    transactionIndex: "0",
    logIndex: String(i),
    topics: [TOPIC_TRANSFER, "0x" + pad(t.from), "0x" + pad(t.to)],
    data: "0x" + word(exact(t)),
  }));

  // One Swap per transaction, carrying the summed BNB on each side. WBNB sorts below the token on
  // this pair, so it is token0: amount0In on a buy, amount0Out on a sell.
  const swapByTx = new Map();
  const addLeg = (list, side) => {
    for (const t of list) {
      const key = t.hash;
      if (!swapByTx.has(key)) {
        swapByTx.set(key, { block: parseInt(t.blockNum, 16), in: 0n, out: 0n });
      }
      swapByTx.get(key)[side] += exact(t);
    }
  };
  addLeg(bnbIn, "in");
  addLeg(bnbOut, "out");

  const swap = [...swapByTx].map(([hash, s], i) => ({
    kind: "swap",
    blockNumber: String(s.block),
    transactionHash: hash,
    transactionIndex: "0",
    logIndex: String(10_000 + i),
    topics: [TOPIC_SWAP, "0x" + pad(pair), "0x" + pad(pair)],
    data: "0x" + word(s.in) + word(0) + word(s.out) + word(0),
  }));

  // Collateral and defaults, read from the vault's own events rather than guessed from transfers.
  //
  // Guessing does not survive contact with the chain. A stakeAndBorrow can land in the same
  // transaction as the vault's idle buyback, and from then on a pledge is indistinguishable in
  // shape from trading tax -- which quietly booked one member's collateral as a sale. The events
  // say which is which exactly, and the 10-block cap on eth_getLogs costs nothing here because the
  // candidate blocks are already known.
  const vaultLogs = await logsAtBlocks(
    alchemy,
    lendingVault,
    [[TOPIC_BORROW_STARTED, TOPIC_REPAID, TOPIC_DEFAULTED]],
    tokenTransfers
      .filter((t) => t.from.toLowerCase() === lendingVault || t.to.toLowerCase() === lendingVault)
      .map((t) => parseInt(t.blockNum, 16)),
    "collateral",
    settledOnly
  );
  const VAULT_KIND = {
    [TOPIC_BORROW_STARTED]: "borrowStarted",
    [TOPIC_REPAID]: "repaid",
    [TOPIC_DEFAULTED]: "defaulted",
  };
  const vaultMoves = vaultLogs.map((log) => asStream(VAULT_KIND[log.topics[0]], 30_000)(log));

  // What each minter paid. The fair mint settles in batches that carry no msg.value and turn the
  // proceeds straight into pool liquidity, so neither the token transfers nor the WBNB legs say
  // what anybody paid -- only Minted does. Without it half the supply looks like a free airdrop.
  const protocol = new Set([token, pair, lendingVault, config.platformVault, config.dead, config.zero]);
  const mintLogs = await logsAtBlocks(
    alchemy,
    token,
    [[TOPIC_MINTED]],
    tokenTransfers
      .filter((t) => t.from.toLowerCase() === token && !protocol.has(t.to.toLowerCase()))
      .map((t) => parseInt(t.blockNum, 16)),
    "mints",
    settledOnly
  );
  const minted = mintLogs.map(asStream("minted", 40_000));

  // The 100-day staking contract, once it exists: deposits and releases, read the same way.
  let stakeMoves = [];
  if (config.staking) {
    const STAKE_KIND = { [TOPIC_STAKED]: "staked", [TOPIC_CLAIMED]: "claimed" };
    const stakeLogs = await logsAtBlocks(
      alchemy,
      config.staking,
      [[TOPIC_STAKED, TOPIC_CLAIMED]],
      tokenTransfers
        .filter((t) => t.from.toLowerCase() === config.staking || t.to.toLowerCase() === config.staking)
        .map((t) => parseInt(t.blockNum, 16)),
      "staking",
      settledOnly
    );
    stakeMoves = stakeLogs.map((log) => asStream(STAKE_KIND[log.topics[0]], 50_000)(log));
  }

  checkAgainstTransfers({ tokenTransfers, exact, vaultMoves, minted, stakeMoves, config });

  const kinds = (k) => vaultMoves.filter((m) => m.kind === k).length;
  console.log(
    `  ${tokenTransfers.length} token transfers, ${swap.length} swap transactions, ` +
    `${kinds("borrowStarted")} pledges, ${kinds("repaid")} redeems, ${kinds("defaulted")} defaults, ` +
    `${minted.length} mints, ${stakeMoves.length} staking events, ${alchemy.calls} calls`
  );

  return { transfer, swap, vaultMoves, minted, stakeMoves, tokenTransfers };
}

/**
 * When each member joined the tree: the block and position of their Bound event.
 *
 * Purchases only count for a team after the buyer bound, so this decides what every number on the
 * team side means. The registry's events are read at the blocks of calls made to it -- listed by
 * getAssetTransfers, which includes zero-value contract calls under "external" -- so this costs a
 * few requests however long the registry has existed.
 *
 * A purchase in the same block as its buyer's binding is ordered by transaction position, which
 * is fetched for exactly those purchases. Everything else is decided by block number alone.
 *
 * @returns {{bindings: Map<string,{block:number,index:number,time:number,tx:string}>, txIndex: Map<string,number>}}
 */
async function fetchBindings(alchemy, registry, tokenTransfers, { cache = NO_CACHE, head } = {}) {
  const bindings = new Map();
  const txIndex = new Map();
  if (!registry) return { bindings, txIndex };

  const calls = await transfersUpTo(alchemy, cache, "registry-calls", { toAddress: registry, category: ["external"] }, head);
  const timeOf = new Map(calls.map((t) => [t.hash.toLowerCase(), secondsOf(t)]));
  const logs = await logsAtBlocks(alchemy, registry, [[TOPIC_BOUND]], calls.map((t) => parseInt(t.blockNum, 16)), "bindings", { cache, head });
  for (const log of logs) {
    const user = "0x" + log.topics[1].slice(26).toLowerCase();
    if (bindings.has(user)) continue; // written once by the contract; the first is the only one
    bindings.set(user, {
      block: parseInt(log.blockNumber, 16),
      index: parseInt(log.transactionIndex, 16),
      time: timeOf.get(log.transactionHash.toLowerCase()) ?? 0,
      tx: log.transactionHash.toLowerCase(),
    });
  }

  const sameBlock = new Map(); // hash -> block
  for (const t of tokenTransfers) {
    const block = parseInt(t.blockNum, 16);
    for (const party of [t.from, t.to]) {
      const bound = bindings.get(String(party).toLowerCase());
      if (bound && bound.block === block) sameBlock.set(t.hash.toLowerCase(), block);
    }
  }
  // A transaction's position in a settled block never changes, so each is asked for once.
  const known = cache.read("tx-index", {});
  const hashes = [...sameBlock.keys()].filter((hash) => !(hash in known));
  const receipts = await alchemy.pool(hashes, (hash) => alchemy.rpc("eth_getTransactionReceipt", [hash]), "ordering");
  let settled = 0;
  hashes.forEach((hash, i) => {
    if (!receipts[i]) return;
    const index = parseInt(receipts[i].transactionIndex, 16);
    txIndex.set(hash, index);
    if (head !== undefined && sameBlock.get(hash) <= head - FINAL_MARGIN) {
      known[hash] = index;
      settled++;
    }
  });
  for (const hash of sameBlock.keys()) if (hash in known) txIndex.set(hash, known[hash]);
  if (settled) cache.write("tx-index", known);

  console.log(`  ${bindings.size} bindings, ${sameBlock.size} same-block purchases ordered`);
  return { bindings, txIndex };
}

/**
 * Every event must correspond to a token transfer in the same transaction, for the same party and
 * the same amount. Nothing downstream could notice if a field were read from the wrong word, and
 * the result would be somebody's collateral or cost basis quietly moved, so a mismatch stops the
 * run rather than reaching a report.
 */
function checkAgainstTransfers({ tokenTransfers, exact, vaultMoves, minted, stakeMoves = [], config }) {
  const byTx = new Map();
  for (const t of tokenTransfers) {
    if (!byTx.has(t.hash)) byTx.set(t.hash, []);
    byTx.get(t.hash).push(t);
  }
  const has = (hash, from, to, amount) =>
    (byTx.get(hash) ?? []).some(
      (t) => t.from.toLowerCase() === from && t.to.toLowerCase() === to && exact(t) === amount
    );
  const party = (log) => "0x" + log.topics[1].slice(26);
  const at = (log, i) => BigInt("0x" + log.data.slice(2 + i * 64, 66 + i * 64));

  const problems = [];
  for (const move of vaultMoves) {
    const who = party(move);
    const [from, to, amount] =
      move.kind === "borrowStarted" ? [who, config.lendingVault, at(move, 0)]
      : move.kind === "repaid" ? [config.lendingVault, who, at(move, 1)]
      : [config.lendingVault, config.dead, at(move, 0)];
    if (amount > 0n && !has(move.transactionHash, from, to, amount)) {
      problems.push(`${move.kind} ${who} @${move.blockNumber}: no transfer of ${amount} from ${from} to ${to}`);
    }
  }
  for (const mint of minted) {
    const who = party(mint);
    const out = at(mint, 1);
    if (out > 0n && !has(mint.transactionHash, config.token, who, out)) {
      problems.push(`mint ${who} @${mint.blockNumber}: no transfer of ${out} from the token`);
    }
  }
  for (const move of stakeMoves) {
    const who = party(move);
    const amount = at(move, 0);
    if (amount === 0n) continue;
    if (move.kind === "staked") {
      // The contract records what arrived, which is exactly what the transfer into it carried.
      if (!has(move.transactionHash, who, config.staking, amount)) {
        problems.push(`stake ${who} @${move.blockNumber}: no transfer of ${amount} into the staking contract`);
      }
    } else {
      // A release reaches the wallet short by the token's dust.
      const arrived = (byTx.get(move.transactionHash) ?? []).some(
        (t) =>
          t.from.toLowerCase() === config.staking &&
          t.to.toLowerCase() === who &&
          exact(t) <= amount &&
          exact(t) + DUST_TOLERANCE >= amount
      );
      if (!arrived) problems.push(`release ${who} @${move.blockNumber}: no transfer near ${amount} from the staking contract`);
    }
  }

  // The existence check above passes on the first identical match, so a batch of identical mints
  // would hide a miscount. The totals cannot.
  const paidOut = tokenTransfers.filter(
    (t) =>
      t.from.toLowerCase() === config.token &&
      ![config.pair, config.lendingVault, config.platformVault, config.dead, config.zero].includes(t.to.toLowerCase())
  );
  const mintedTokens = minted.reduce((sum, m) => sum + at(m, 1), 0n);
  const paidTokens = paidOut.reduce((sum, t) => sum + exact(t), 0n);
  if (minted.length !== paidOut.length || mintedTokens !== paidTokens) {
    problems.push(
      `mint totals: ${minted.length} events for ${paidOut.length} transfers, ` +
      `${mintedTokens} vs ${paidTokens} tokens`
    );
  }

  if (problems.length) {
    throw new Error(`events do not match the transfers (${problems.length}):\n  ` + problems.slice(0, 10).join("\n  "));
  }
}

module.exports = {
  Alchemy,
  PriceOracle,
  DiskCache,
  FINAL_MARGIN,
  fetchHistory,
  fetchBindings,
  transfersUpTo,
  logsAtBlocks,
  checkAgainstTransfers,
  CHAINLINK_BNB_USD,
};
