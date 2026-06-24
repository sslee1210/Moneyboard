import "dotenv/config";

const fastDefaults = {
  MARKET_CACHE_MS: "3000",
  DETAIL_CACHE_MS: "3000",
  OVERVIEW_CACHE_MS: "3000",
  REQUEST_TIMEOUT_MS: "5000",
  DETAIL_CONCURRENCY: "24",
  VOLUME_HISTORY_LIMIT: "12",
  PRECISION_WATCH_LIMIT: "40",
  PRECISION_SOURCE_TOP_SECTORS: "16",
  PRECISION_MIN_TRADE_AMOUNT_MILLION: "0",
  PRECISION_API_PROVIDER: "kiwoom",
  PRECISION_MARKET_SCOPE: "KRX_SELECTED",
  KIWOOM_WATCH_LIMIT: "40",
  KIWOOM_REGISTER_REFRESH_MS: "3000",
  KIWOOM_REALTIME_PUSH_MS: "1000",
  KIWOOM_RESELECT_MS: "3000",
  KIWOOM_REAL_FIDS: "10;13;14;15;20;228"
};

for (const [key, value] of Object.entries(fastDefaults)) {
  if (!process.env[key]) process.env[key] = value;
}

console.log(
  `[fast-runtime] Naver/Yahoo fast mode: market=${process.env.MARKET_CACHE_MS}ms, detail=${process.env.DETAIL_CACHE_MS}ms, overview=${process.env.OVERVIEW_CACHE_MS}ms, concurrency=${process.env.DETAIL_CONCURRENCY}`
);
console.log(
  `[fast-runtime] selected watchlist: limit=${process.env.PRECISION_WATCH_LIMIT}, sourceTopSectors=${process.env.PRECISION_SOURCE_TOP_SECTORS}, provider=${process.env.PRECISION_API_PROVIDER}`
);

await import("./run-vite-server.mjs");
