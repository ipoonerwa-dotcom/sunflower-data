"use strict";
/**
 * Where the numbers come from.
 *
 * Free BSC RPCs no longer serve historical logs -- the dataseed nodes refuse eth_getLogs outright,
 * publicnode answers only for recent blocks and wants a paid token for anything archived. So the
 * backfill runs through the Etherscan V2 API, which covers BSC on chainid 56 and is free at
 * 100k calls a day. Set ETHERSCAN_API_KEY.
 */

const API = "https://api.etherscan.io/v2/api";
const CHAIN_ID = 56;
const PAGE = 1000; // the API's maximum per page
const MAX_PAGES = 10; // it stops paginating past 10k results, so ranges are split instead

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Etherscan {
  constructor(apiKey, { requestsPerSecond = 4 } = {}) {
    if (!apiKey) throw new Error("ETHERSCAN_API_KEY is not set");
    this.apiKey = apiKey;
    this.minGap = 1000 / requestsPerSecond;
    this.lastCall = 0;
    this.calls = 0;
  }

  async get(params) {
    const wait = this.minGap - (Date.now() - this.lastCall);
    if (wait > 0) await sleep(wait);
    const url = `${API}?chainid=${CHAIN_ID}&${new URLSearchParams({ ...params, apikey: this.apiKey })}`;
    for (let attempt = 0; attempt < 4; attempt++) {
      this.lastCall = Date.now();
      this.calls++;
      const response = await fetch(url);
      const body = await response.json();
      // "No records found" is a valid empty answer, not a failure.
      if (body.status === "1") return body.result;
      if (typeof body.result === "string" && /no records|not found/i.test(body.result)) return [];
      if (typeof body.message === "string" && /No records found/i.test(body.message)) return [];
      if (attempt === 3) {
        throw new Error(`Etherscan: ${body.message} ${JSON.stringify(body.result).slice(0, 160)}`);
      }
      await sleep(600 * (attempt + 1)); // rate limited or briefly unhappy
    }
    return [];
  }

  /**
   * Every matching log in a block range, splitting the range whenever the API's 10k ceiling is hit
   * so nothing is silently dropped.
   */
  async logs(address, topic0, fromBlock, toBlock) {
    const out = [];
    const queue = [[fromBlock, toBlock]];
    while (queue.length) {
      const [lo, hi] = queue.pop();
      let page = 1;
      let got = 0;
      for (; page <= MAX_PAGES; page++) {
        const rows = await this.get({
          module: "logs",
          action: "getLogs",
          address,
          ...(topic0 ? { topic0 } : {}),
          fromBlock: String(lo),
          toBlock: String(hi),
          page: String(page),
          offset: String(PAGE),
        });
        out.push(...rows);
        got += rows.length;
        if (rows.length < PAGE) break;
      }
      // A full 10k means the window was too wide to see all of; halve it and look again.
      if (got >= PAGE * MAX_PAGES && hi > lo) {
        out.length -= got;
        const mid = Math.floor((lo + hi) / 2);
        queue.push([lo, mid], [mid + 1, hi]);
      }
    }
    return out.sort(
      (a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex)
    );
  }

  async blockNumber() {
    const hex = await this.get({ module: "proxy", action: "eth_blockNumber" });
    return parseInt(hex, 16);
  }
}

/** A read-only JSON-RPC client for the handful of current-state calls the report needs. */
class Rpc {
  constructor(url = "https://bsc-dataseed.bnbchain.org") {
    this.url = url;
    this.id = 1;
  }
  async call(method, params) {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.id++, method, params }),
    });
    const body = await response.json();
    if (body.error) throw new Error(body.error.message);
    return body.result;
  }
  async ethCall(to, data) {
    return this.call("eth_call", [{ to, data }, "latest"]);
  }
}

/**
 * The same log interface, served by any archive RPC instead of Etherscan.
 *
 * No free BSC endpoint can do this -- sixteen were measured and every one either refuses
 * eth_getLogs, serves only recent blocks, or caps the window at fifty blocks without archive state.
 * So this is for a paid endpoint: Alchemy, QuickNode, NodeReal, Chainstack, dRPC with a key. Point
 * RPC_URL at it and set RPC_LOG_CHUNK to the widest window it accepts.
 */
class RpcLogs {
  constructor(url, { chunk = 2000, concurrency = 4, retries = 3 } = {}) {
    if (!url) throw new Error("RPC_URL is not set");
    this.rpc = new Rpc(url);
    this.chunk = chunk;
    this.concurrency = concurrency;
    this.retries = retries;
    this.calls = 0;
  }

  async blockNumber() {
    return parseInt(await this.rpc.call("eth_blockNumber", []), 16);
  }

  async window(address, topic0, from, to) {
    for (let attempt = 0; ; attempt++) {
      try {
        this.calls++;
        return await this.rpc.call("eth_getLogs", [{
          address,
          ...(topic0 ? { topics: [topic0] } : {}),
          fromBlock: "0x" + from.toString(16),
          toBlock: "0x" + to.toString(16),
        }]);
      } catch (error) {
        // A window too wide for this provider is worth halving once rather than failing the run.
        if (/too many|range|limit|exceed/i.test(error.message) && to > from) {
          const mid = Math.floor((from + to) / 2);
          const [left, right] = [await this.window(address, topic0, from, mid), await this.window(address, topic0, mid + 1, to)];
          return [...left, ...right];
        }
        if (attempt >= this.retries) throw error;
        await sleep(500 * (attempt + 1));
      }
    }
  }

  async logs(address, topic0, fromBlock, toBlock) {
    const windows = [];
    for (let from = fromBlock; from <= toBlock; from += this.chunk) {
      windows.push([from, Math.min(from + this.chunk - 1, toBlock)]);
    }
    const out = [];
    let done = 0;
    for (let i = 0; i < windows.length; i += this.concurrency) {
      const batch = windows.slice(i, i + this.concurrency);
      const results = await Promise.all(batch.map(([lo, hi]) => this.window(address, topic0, lo, hi)));
      for (const rows of results) out.push(...rows);
      done += batch.length;
      if (done % 100 < this.concurrency) {
        process.stdout.write(`\r  ${address.slice(0, 10)}… ${done}/${windows.length} windows, ${out.length} logs`);
      }
    }
    if (windows.length > 100) process.stdout.write("\r" + " ".repeat(70) + "\r");
    return out.sort(
      (a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex)
    );
  }
}

const hexToBig = (hex) => BigInt(hex.length % 2 ? "0x0" + hex.slice(2) : hex);
const wordAt = (data, index) => BigInt("0x" + data.slice(2).slice(index * 64, (index + 1) * 64));
const addressAt = (topicOrData) => "0x" + topicOrData.slice(-40).toLowerCase();

module.exports = { Etherscan, Rpc, RpcLogs, hexToBig, wordAt, addressAt };
