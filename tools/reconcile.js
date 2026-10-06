"use strict";
/**
 * Proves a full report against the chain before anybody is paid from it, or before it is published.
 *
 *   node tools/reconcile.js [report.json]     # reports/report-full.json by default
 *
 * It needs the full report, every holder included. The members-only copy the page reads cannot be
 * reconciled: the totals would be missing everybody who never bound.
 *
 * Two checks, both read at the report's own scannedTo block rather than at the head. This token
 * trades continuously, and comparing a report with a later head measures the minutes in between,
 * not the accounting -- which once made a correct row look 63 tokens wrong.
 *
 *   1. Totals. What the report says members hold, collateral included, must equal the supply
 *      less whatever sits in protocol addresses.
 *   2. Every row. Each address must hold exactly its real balance plus its pledged collateral.
 *
 * Exits non-zero on any mismatch, so it can gate whatever pays out.
 */

const fs = require("fs");
const path = require("path");
const { Interface } = require("ethers");
const { loadEnv } = require("../indexer/env");
const { Alchemy } = require("../indexer/alchemy");
const { CONFIG, EXCLUDED } = require("../indexer/index");

loadEnv();

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const BATCH = 400;
const multicall3 = new Interface([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])",
]);
const erc20 = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);

const tokens = (v) =>
  (Number(v / 10n ** 14n) / 1e4).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });

async function balancesAt(alchemy, addresses, at) {
  const batches = [];
  for (let i = 0; i < addresses.length; i += BATCH) batches.push(addresses.slice(i, i + BATCH));
  const results = await alchemy.pool(
    batches,
    async (batch) => {
      const data = multicall3.encodeFunctionData("aggregate3", [
        batch.map((address) => ({
          target: CONFIG.token,
          allowFailure: false,
          callData: erc20.encodeFunctionData("balanceOf", [address]),
        })),
      ]);
      const raw = await alchemy.rpc("eth_call", [{ to: MULTICALL3, data }, at]);
      const [rows] = multicall3.decodeFunctionResult("aggregate3", raw);
      return batch.map((address, i) => [address, BigInt(rows[i][1])]);
    },
    "balances"
  );
  return new Map(results.flat());
}

async function main() {
  const file = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, "..", "reports", "report-full.json");
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!report.scannedTo) throw new Error(`${file} has no scannedTo -- is it the demo report?`);

  const at = "0x" + report.scannedTo.toString(16);
  const alchemy = new Alchemy(process.env.RPC_URL);
  console.log(`核对 ${report.rows.length} 个地址，锁定在报表自己的高度 ${report.scannedTo}\n`);

  const protocol = [...EXCLUDED];
  const [supplyRaw, balance] = await Promise.all([
    alchemy.rpc("eth_call", [{ to: CONFIG.token, data: erc20.encodeFunctionData("totalSupply") }, at]),
    balancesAt(alchemy, [...protocol, ...report.rows.map((r) => r.address)], at),
  ]);

  // 1. Totals
  const supply = BigInt(supplyRaw);
  const inProtocol = protocol.reduce((sum, a) => sum + balance.get(a), 0n);
  const staked = report.rows.reduce((sum, r) => sum + BigInt(r.staked) + BigInt(r.locked ?? 0), 0n);
  const held = report.rows.reduce((sum, r) => sum + BigInt(r.heldTokens), 0n);
  const expected = supply - inProtocol + staked;
  const gap = held - expected;

  console.log("\n总量");
  console.log(`  总供应                  ${tokens(supply)}`);
  console.log(`  协议地址合计            ${tokens(inProtocol)}   （池子、借贷金库、代币税池、平台金库、销毁）`);
  console.log(`  会员抵押与理财合计      ${tokens(staked)}   （借贷金库实际余额 ${tokens(balance.get(CONFIG.lendingVault))}）`);
  console.log(`  报表应覆盖              ${tokens(expected)}`);
  console.log(`  报表持仓合计            ${tokens(held)}`);
  console.log(`  差额                    ${tokens(gap)}  ${gap === 0n ? "✓" : "✗"}`);

  // 2. Every row
  const off = report.rows
    .map((r) => ({ ...r, diff: BigInt(r.heldTokens) - (balance.get(r.address) + BigInt(r.staked) + BigInt(r.locked ?? 0)) }))
    .filter((r) => r.diff !== 0n);

  console.log("\n逐地址");
  if (off.length === 0) {
    console.log(`  ✓ 全部 ${report.rows.length} 个地址：报表持仓 = 链上余额 + 抵押 + 理财本金，一枚不差`);
  } else {
    console.log(`  ✗ ${off.length} 个地址对不上：`);
    for (const r of off.slice(0, 20)) {
      console.log(
        `    ${r.address}  报表 ${tokens(BigInt(r.heldTokens))}  链上 ${tokens(balance.get(r.address))}` +
          `  抵押 ${tokens(BigInt(r.staked))}  差 ${tokens(r.diff)}`
      );
    }
  }

  console.log(`\n${alchemy.calls} 次调用`);
  if (gap !== 0n || off.length) process.exit(1);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
