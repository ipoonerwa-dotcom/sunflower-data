"use strict";
/**
 * Builds the team performance report for SUNFLOWER.
 *
 *   ETHERSCAN_API_KEY=... node indexer/index.js
 *
 * Reads the pair, the token, the lending vault, the referral registry and the BNB/USD feed, then
 * replays everything in order through the accounting rules in ./accounting.js and writes
 * report.json.
 *
 * Token movements are netted per transaction rather than followed log by log. A tax token can move
 * the same tokens two or three times inside one buy -- pool to buyer, buyer to vault for the tax --
 * and an aggregator adds more hops still. What a member actually gained or lost is the net change
 * across the whole transaction, so that is what gets recorded.
 */

const fs = require("fs");
const path = require("path");
const { id, Interface } = require("ethers");
const { Ledger, USD_SCALE, formatUsd } = require("./accounting");
const { wordAt, addressAt } = require("./sources");
const { Alchemy, PriceOracle, DiskCache, fetchHistory, fetchBindings } = require("./alchemy");
const { loadEnv } = require("./env");

loadEnv();

const CONFIG = {
  token: "0xfd06eeadc43ee0687d5611d698fb2ee39f9baaaa",
  pair: "0x72861674beea6a8046e485327adac898ee2e611d",
  lendingVault: "0xdda9d6c1738ea47e047b220a6fecc3cfc9d65cb6",
  platformVault: "0xcb8c07c87a698329060e122edf383b581274c7fe",
  wbnb: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
  dead: "0x000000000000000000000000000000000000dead",
  zero: "0x0000000000000000000000000000000000000000",
  chainlinkBnbUsd: "0x0567f2323251f0aab15c8dfb1967e4e8a7d42aee",
  // The deployed contracts, so the scheduled job needs nothing but an RPC URL. The environment can
  // still point elsewhere, for a fork or a redeployment.
  registry: process.env.REGISTRY_ADDRESS || "0xFD58e05fFc519B3fd7E28FeD770845C19D696FAB",
  // The 100-day staking contract. Staked tokens stay their owner's, like collateral in the vault.
  staking: (process.env.STAKING_ADDRESS || "0xb05C26c55134f249f4cB228c5Ec70189446561aD").toLowerCase(),
  // The root is in the tree from the moment the registry exists, so that is where its purchases
  // start to count. Block and position of the deployment, from broadcast/Deploy.s.sol/56.
  root: "0xa666eae830201c62fe3e0c07bd956e5d516cd419",
  registryDeployed: { block: 125_264_936, index: 132 },
  // Everything was reset here, at the project's request (2026-10-03 22:53:03 Beijing): performance
  // counts from block 125,503,648 on, whenever a member bound. Expressed as the very end of the
  // block before, so that every transaction in the reset block itself counts.
  countFrom: { block: 125_503_647, index: Infinity, time: 1_791_039_183 },
  // The token launched on 2026-09-24. BSC produces a block every ~0.45s, so a fortnight back is a
  // safe start that still skips 99% of the chain. Set FROM_BLOCK once the pair's creation block is
  // known, so the backfill stops re-reading empty ranges.
  fromBlock: Number(process.env.FROM_BLOCK || 0),
  lookbackBlocks: Number(process.env.LOOKBACK_BLOCKS || 2_700_000),
};

const TOPIC = {
  transfer: id("Transfer(address,address,uint256)"),
  swap: id("Swap(address,uint256,uint256,uint256,uint256,address)"),
  borrowStarted: id("BorrowStarted(address,uint256,uint256,uint256,uint256)"),
  repaid: id("RepaidAndUnstaked(address,uint256,uint256)"),
  defaulted: id("Defaulted(address,address,uint256,uint256)"),
  minted: id("Minted(address,uint256,uint256)"),
};

/**
 * Addresses whose balance is protocol machinery, not a member's position.
 *
 * The token contract is one of them: it is where the 3% tax accumulates before being swapped for
 * BNB, and it is also what pays out the fair mint. Left in, it collects tax as though it were
 * buying and sells it as though it were dumping, and shows up in the ranking above most members.
 */
const EXCLUDED = new Set(
  [CONFIG.token, CONFIG.pair, CONFIG.lendingVault, CONFIG.platformVault, CONFIG.dead, CONFIG.zero, CONFIG.staking].filter(Boolean)
);

/** BNB/USD over time, so every buy is valued at the moment it happened. */
class PriceTimeline {
  constructor(points) {
    this.points = points.sort((a, b) => a.block - b.block); // {block, usd18}
  }
  at(block) {
    if (this.points.length === 0) return 0n;
    let lo = 0;
    let hi = this.points.length - 1;
    if (block <= this.points[0].block) return this.points[0].usd18;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.points[mid].block <= block) lo = mid;
      else hi = mid - 1;
    }
    return this.points[lo].usd18;
  }
}

/** Groups every log of one transaction together, in chain order. */
function groupByTransaction(streams) {
  const byTx = new Map();
  for (const [kind, logs] of Object.entries(streams)) {
    for (const log of logs) {
      const key = log.transactionHash;
      if (!byTx.has(key)) {
        byTx.set(key, { block: Number(log.blockNumber), index: Number(log.transactionIndex ?? 0), time: 0, logs: [] });
      }
      const tx = byTx.get(key);
      // Only the token transfers carry a timestamp, and every transaction that matters has one.
      if (!tx.time && log.timeStamp) tx.time = Number(log.timeStamp);
      tx.logs.push({ kind, log });
    }
  }
  return [...byTx.entries()]
    .map(([hash, tx]) => ({ hash, ...tx }))
    .sort((a, b) => a.block - b.block || a.index - b.index);
}

/**
 * Where each member's performance starts: their binding, or the reset if they bound before it.
 * Positions compare by block, then by transaction position inside the block.
 */
function startsFrom(bindings, countFrom) {
  const later = (a, b) => (a.block !== b.block ? a.block > b.block : a.index > b.index);
  const starts = new Map();
  for (const [address, bound] of bindings) {
    starts.set(address, countFrom && later(countFrom, bound) ? { ...bound, ...countFrom } : bound);
  }
  return starts;
}

/**
 * @param {object} [options]
 * @param {Map<string,{block:number,index:number}>} [options.bindings] where each member's counting starts
 * @param {Map<string,number>} [options.txIndex] transaction positions, for purchases in a binding's own block
 */
function replay(transactions, prices, { bindings = new Map(), txIndex = new Map() } = {}) {
  const ledger = new Ledger({ excluded: EXCLUDED });
  const isExcluded = (a) => EXCLUDED.has(a);
  for (const [address, where] of bindings) ledger.bind(address, where);

  for (const tx of transactions) {
    ledger.setClock(tx.block, txIndex.get(String(tx.hash).toLowerCase()), tx.time);
    const net = new Map(); // address -> net token change across the whole transaction
    const bump = (address, delta) => net.set(address, (net.get(address) ?? 0n) + delta);
    let bnbIn = 0n;
    let bnbOut = 0n;
    let pairIn = 0n;
    let pairOut = 0n;
    let sawSwap = false;
    const vaultMoves = [];
    const mints = [];

    for (const { kind, log } of tx.logs) {
      if (kind === "transfer") {
        const from = addressAt(log.topics[1]);
        const to = addressAt(log.topics[2]);
        const value = BigInt(log.data);
        bump(from, -value);
        bump(to, value);
        if (from === CONFIG.pair) pairOut += value;
        if (to === CONFIG.pair) pairIn += value;
      } else if (kind === "swap") {
        sawSwap = true;
        const [a0In, a1In, a0Out, a1Out] = [0, 1, 2, 3].map((i) => wordAt(log.data, i));
        // token0/token1 order decides which side is BNB; the pair holds WBNB and the token only.
        const wbnbIsToken0 = CONFIG.wbnb < CONFIG.token;
        bnbIn += wbnbIsToken0 ? a0In : a1In;
        bnbOut += wbnbIsToken0 ? a0Out : a1Out;
      } else if (kind === "borrowStarted") {
        vaultMoves.push({ type: "pledge", address: addressAt(log.topics[1]), tokens: wordAt(log.data, 0) });
      } else if (kind === "repaid") {
        vaultMoves.push({ type: "redeem", address: addressAt(log.topics[1]), tokens: wordAt(log.data, 1) });
      } else if (kind === "defaulted") {
        vaultMoves.push({ type: "default", address: addressAt(log.topics[1]), tokens: wordAt(log.data, 0) });
      } else if (kind === "staked") {
        vaultMoves.push({ type: "lock", address: addressAt(log.topics[1]), tokens: wordAt(log.data, 0) });
      } else if (kind === "claimed") {
        vaultMoves.push({ type: "unlock", address: addressAt(log.topics[1]), tokens: wordAt(log.data, 0) });
      } else if (kind === "minted") {
        mints.push({
          address: addressAt(log.topics[1]),
          paid: wordAt(log.data, 0),
          tokens: wordAt(log.data, 1),
        });
      }
    }

    const price = prices.at(tx.block);
    const usdOf = (wei) => (wei * price) / USD_SCALE;
    const meta = (bnb, source) => ({ time: tx.time, block: tx.block, tx: tx.hash, bnb, source });

    // Collateral and staking first, and take them out of the net so neither reads as a sale or a
    // purchase. A staking bonus is not cancelled: it stays in the net and lands as a gift.
    for (const move of vaultMoves) {
      ledger.apply(move);
      if (move.type === "pledge" || move.type === "lock") bump(move.address, move.tokens);
      if (move.type === "redeem" || move.type === "unlock") bump(move.address, -move.tokens);
    }

    // A mint is a purchase at a price only the Minted event knows, so the tokens arriving are that
    // purchase and come out of the net too -- otherwise they would be counted again as a gift.
    for (const mint of mints) {
      ledger.buy(mint.address, mint.tokens, usdOf(mint.paid), meta(mint.paid, "mint"));
      bump(mint.address, -mint.tokens);
    }

    const gainers = [...net].filter(([a, d]) => d > 0n && !isExcluded(a));
    const losers = [...net].filter(([a, d]) => d < 0n && !isExcluded(a));

    // BNB crossing the pool is not enough to call something a trade: adding liquidity sends BNB in
    // and removing it sends BNB out, with nobody buying or selling. What separates them is which
    // way the tokens went. A buy takes tokens out of the pool, a sale puts them in -- and the fair
    // mint, which adds its proceeds as liquidity, does neither.
    const bought = pairOut > 0n;
    const sold = pairIn > 0n;

    if (sawSwap && bnbIn > 0n && bought && gainers.length) {
      const totalGained = gainers.reduce((sum, [, d]) => sum + d, 0n);
      const totalUsd = usdOf(bnbIn);
      for (const [address, delta] of gainers) {
        const bnb = (bnbIn * delta) / totalGained;
        ledger.buy(address, delta, (totalUsd * delta) / totalGained, meta(bnb, "swap"));
      }
    } else {
      for (const [address, delta] of gainers) ledger.receive(address, delta);
    }

    if (sawSwap && bnbOut > 0n && sold && losers.length) {
      const totalLost = losers.reduce((sum, [, d]) => sum - d, 0n);
      const totalUsd = usdOf(bnbOut);
      for (const [address, delta] of losers) {
        ledger.sell(address, -delta, (totalUsd * -delta) / totalLost);
      }
    } else {
      for (const [address, delta] of losers) ledger.release(address, -delta);
    }
  }
  return ledger;
}

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const multicall3 = new Interface([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])",
]);
const REFERRER_OF = id("referrer(address)").slice(0, 10);
const MEMBER_COUNT = id("memberCount()").slice(0, 10);
const TREE_BATCH = 400;

/**
 * The referral tree, read as current state rather than replayed from events.
 *
 * Replaying Bound events would mean eth_getLogs over every block since the registry was deployed,
 * which this plan caps at ten blocks a call -- a hundred thousand calls on day one and worse every
 * week. And the owner can correct a mistaken binding, so the events would have to be folded in
 * order anyway. One referrer() read per address answers both: it is the edge as it stands now,
 * corrections included.
 *
 * Seeded with every address the ledger knows, then closed over what comes back. A member may have
 * bound without ever trading, and their edge still has to be there for their downline to reach the
 * root through them.
 */
async function readTree(alchemy, registry, seeds, at = "latest") {
  const referrerOf = new Map();
  const childrenOf = new Map();
  if (!registry) return { referrerOf, childrenOf };

  const asked = new Set();
  let frontier = [...new Set(seeds.map((a) => a.toLowerCase()))];

  while (frontier.length) {
    for (const address of frontier) asked.add(address);
    const batches = [];
    for (let i = 0; i < frontier.length; i += TREE_BATCH) {
      batches.push(frontier.slice(i, i + TREE_BATCH));
    }

    const answers = await alchemy.pool(
      batches,
      async (batch) => {
        const data = multicall3.encodeFunctionData("aggregate3", [
          batch.map((address) => ({
            target: registry,
            allowFailure: false,
            callData: REFERRER_OF + address.slice(2).padStart(64, "0"),
          })),
        ]);
        const raw = await alchemy.rpc("eth_call", [{ to: MULTICALL3, data }, at]);
        const [results] = multicall3.decodeFunctionResult("aggregate3", raw);
        return batch.map((address, i) => [address, addressAt(results[i][1])]);
      },
      "tree"
    );

    const next = new Set();
    for (const [address, upline] of answers.flat()) {
      if (upline === CONFIG.zero) continue; // the root, or never bound
      referrerOf.set(address, upline);
      if (!childrenOf.has(upline)) childrenOf.set(upline, []);
      childrenOf.get(upline).push(address);
      if (!asked.has(upline)) next.add(upline);
    }
    frontier = [...next];
  }
  return { referrerOf, childrenOf };
}

/**
 * What the page needs: the members and the edges between them. Everyone else in the full report is
 * a holder who never bound -- kept there so reconcile.js can account for every token -- and would
 * only make the page slower to open on a phone.
 */
function forPage(report) {
  const members = new Set([...Object.keys(report.tree), ...Object.values(report.tree), ...Object.keys(report.bound)]);
  const rows = report.rows.filter((row) => members.has(row.address));
  return { ...report, members: rows.length, rows };
}

/**
 * `--full <file>` for the whole report, which reconcile.js checks; `--page <file>` for the
 * members-only copy the page reads. By default the page copy goes into web/, where it ships with
 * the site as the fallback, and the full one beside it in reports/.
 */
function outputsFrom(argv) {
  const value = (flag) => {
    const at = argv.indexOf(flag);
    return at >= 0 && argv[at + 1] ? path.resolve(argv[at + 1]) : null;
  };
  const root = path.join(__dirname, "..");
  return {
    full: value("--full") ?? path.join(root, "reports", "report-full.json"),
    page: value("--page") ?? path.join(root, "web", "report.json"),
  };
}

function writeJson(file, value, pretty) {
  const asJson = (_key, v) => (typeof v === "bigint" ? v.toString() : v);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, asJson, pretty ? 2 : 0));
}

/**
 * How far behind the chain's newest block a run reads: about half a minute on BSC. Read exactly at
 * the tip, 2 of the first 66 scheduled runs failed their own reconciliation. The newest blocks can
 * still be replaced, and the node's transfer index trails the tip by a moment; a little behind it,
 * neither can happen.
 */
const HEAD_LAG = 64;

async function main() {
  const outputs = outputsFrom(process.argv.slice(2));
  const alchemy = new Alchemy(process.env.RPC_URL);
  // Every read is taken at one block, so the report is a single snapshot that reconcile.js checks at
  // exactly that height. HEAD_BLOCK pins it, which is how an incremental run is compared with a
  // full one.
  const head = Number(process.env.HEAD_BLOCK) || (await alchemy.blockNumber()) - HEAD_LAG;
  const at = "0x" + head.toString(16);
  console.log(`head ${head}`);
  // What earlier runs read. Without it every run starts from the token's first block.
  const cache = new DiskCache(process.env.CACHE_DIR || path.join(__dirname, "..", ".cache"));

  const history = await fetchHistory(alchemy, CONFIG, { cache, head });
  const { bindings, txIndex } = await fetchBindings(alchemy, CONFIG.registry, history.tokenTransfers, { cache, head });
  if (CONFIG.registry) {
    const { block } = CONFIG.registryDeployed;
    const times = cache.read("block-times", {});
    if (!(block in times)) {
      const deployed = await alchemy.rpc("eth_getBlockByNumber", ["0x" + block.toString(16), false]);
      times[block] = parseInt(deployed.timestamp, 16);
      cache.write("block-times", times);
    }
    bindings.set(CONFIG.root, { ...CONFIG.registryDeployed, time: times[block], tx: "" });
  }
  const starts = startsFrom(bindings, CONFIG.countFrom);

  // Prices only matter where money changed hands, so only those blocks are read.
  const prices = new PriceOracle(alchemy, process.env.PRICE_CACHE || undefined);
  await prices.warm([...history.swap, ...history.minted].map((log) => Number(log.blockNumber)));

  const byKind = (kind) => history.vaultMoves.filter((m) => m.kind === kind);
  const ledger = replay(
    groupByTransaction({
      transfer: history.transfer,
      swap: history.swap,
      borrowStarted: byKind("borrowStarted"),
      repaid: byKind("repaid"),
      defaulted: byKind("defaulted"),
      minted: history.minted,
      staked: history.stakeMoves.filter((m) => m.kind === "staked"),
      claimed: history.stakeMoves.filter((m) => m.kind === "claimed"),
    }),
    prices,
    { bindings: starts, txIndex }
  );

  // Only a bound address has a referrer, so the members found by their bindings usually make the
  // whole tree in one call. Should the registry count more -- somebody who bound through a contract,
  // whose call the binding scan never saw -- every address the ledger knows is asked as well, so a
  // member who bound and has not bought anything yet still lands in their referrer's network.
  let tree = await readTree(alchemy, CONFIG.registry, [...bindings.keys()], at);
  if (CONFIG.registry) {
    const onChain = Number(await alchemy.rpc("eth_call", [{ to: CONFIG.registry, data: MEMBER_COUNT }, at]));
    if (tree.referrerOf.size < onChain) {
      tree = await readTree(alchemy, CONFIG.registry, [...new Set([...ledger.accounts.keys(), ...bindings.keys()])], at);
    }
    console.log(`  tree: ${tree.referrerOf.size} of ${onChain} bound members found`);
  }
  const { referrerOf, childrenOf } = tree;

  const rows = ledger.ranking().map((row) => ({
    ...row,
    referrer: referrerOf.get(row.address) ?? null,
    teamUsd: ledger.teamUsd(row.address, childrenOf),
  }));

  const report = {
    generatedAt: new Date().toISOString(),
    scannedTo: head,
    token: CONFIG.token,
    registry: CONFIG.registry || null,
    members: rows.length,
    apiCalls: alchemy.calls,
    // Every edge, including members who bound but never traded: the page walks this upward to find
    // a member's studio, and a gap in the middle would cut everyone below it off from their name.
    tree: Object.fromEntries(referrerOf),
    // When each member's performance starts counting (unix seconds): the later of their binding and
    // the reset. Purchases before it count for nobody.
    bound: Object.fromEntries([...starts].map(([address, b]) => [address, b.time])),
    countFrom: CONFIG.countFrom.time,
    rows,
  };
  // The full report is what reconcile.js proves against the chain; the page reads the members-only
  // copy, which the scheduled job publishes only once the full one has passed.
  writeJson(outputs.full, report, true);
  writeJson(outputs.page, forPage(report), false);

  console.log(`\n${"address".padEnd(44)}${"personal".padStart(14)}${"team".padStart(14)}${"held".padStart(16)}`);
  for (const row of rows.slice(0, 25)) {
    console.log(
      row.address.padEnd(44) +
        formatUsd(row.teamPerformanceUsd).padStart(14) +
        formatUsd(row.teamUsd).padStart(14) +
        (Number(row.heldTokens) / 1e18).toFixed(2).padStart(16)
    );
  }
  console.log(`\n${rows.length} addresses, ${alchemy.calls} API calls -> ${outputs.full}`);
  console.log(`  by method: ${Object.entries(alchemy.byMethod).map(([m, n]) => `${m} ${n}`).join(", ")}`);
  console.log(`  page copy: ${forPage(report).rows.length} member rows -> ${outputs.page}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { replay, groupByTransaction, readTree, startsFrom, forPage, PriceTimeline, CONFIG, TOPIC, EXCLUDED };
