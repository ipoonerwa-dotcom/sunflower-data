#!/usr/bin/env bash
# Builds the report and proves it against on-chain balances. A report is left in site/ for
# publishing only if the proof passed.
#
# A failed attempt is retried once as it is, a little later. If that fails too, the chain data kept
# from earlier runs is itself suspect, so it is dropped and everything is read again from the
# token's first block: slower, but it cannot inherit a bad cache. Only when that fails as well does
# the run fail, and the report published before stays up.
set -u

CACHE="${CACHE_DIR:-.cache}"

attempt() {
  node indexer/index.js --full out/report-full.json --page site/report.json &&
    node tools/reconcile.js out/report-full.json
}

attempt && exit 0

echo "::warning::第一次没有通过，${RETRY_WAIT:-30} 秒后重试"
sleep "${RETRY_WAIT:-30}"
attempt && exit 0

echo "::warning::重试仍没有通过：丢掉缓存的链上数据，从头重新读一遍"
rm -f "$CACHE"/transfers-*.json "$CACHE"/logs-*.json "$CACHE"/tx-index.json
attempt && exit 0

rm -f site/report.json
echo "::error::从头重读后仍然不通过。这次不发布，网站继续显示上一份数据。"
exit 1
