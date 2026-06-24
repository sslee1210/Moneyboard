import "dotenv/config";

const fastDefaults = {
  MARKET_CACHE_MS: "3000",
  DETAIL_CACHE_MS: "3000",
  OVERVIEW_CACHE_MS: "3000",
  REQUEST_TIMEOUT_MS: "5000",
  DETAIL_CONCURRENCY: "24",
  VOLUME_HISTORY_LIMIT: "12",
  SECTOR_TOP_STOCK_LIMIT: "300",
  PRECISION_WATCH_LIMIT: "40",
  PRECISION_SOURCE_TOP_SECTORS: "16",
  PRECISION_MIN_TRADE_AMOUNT_MILLION: "0",
  PRECISION_API_PROVIDER: "kiwoom",
  PRECISION_MARKET_SCOPE: "KRX_SELECTED",
  KIWOOM_WATCH_LIMIT: "40",
  KIWOOM_REGISTER_REFRESH_MS: "3000",
  KIWOOM_REALTIME_PUSH_MS: "1000",
  KIWOOM_RESELECT_MS: "3000",
  KIWOOM_REAL_FIDS: "10;12;13;14;15;20;228",
  KIWOOM_TRADE_AMOUNT_MILLION_SCALE: "0.1",
  KIWOOM_PRICE_SCALE: "1"
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
console.log(
  `[fast-runtime] sector search coverage: topStocks=${process.env.SECTOR_TOP_STOCK_LIMIT} per sector`
);
console.log(
  `[fast-runtime] kiwoom trade amount scale: ${process.env.KIWOOM_TRADE_AMOUNT_MILLION_SCALE}x raw FID14 => million KRW`
);

await import("./run-vite-server.mjs");
