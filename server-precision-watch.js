const DEFAULT_WATCH_LIMIT = Number(process.env.PRECISION_WATCH_LIMIT || 40);
const DEFAULT_SOURCE_TOP_SECTORS = Number(process.env.PRECISION_SOURCE_TOP_SECTORS || 12);
const DEFAULT_MIN_TRADE_AMOUNT_MILLION = Number(process.env.PRECISION_MIN_TRADE_AMOUNT_MILLION || 0);

const EXCLUDED_PRODUCT_KEYWORDS = [
  "ETF",
  "ETN",
  "ELW",
  "KODEX",
  "TIGER",
  "ACE",
  "RISE",
  "SOL",
  "HANARO",
  "KBSTAR",
  "ARIRANG",
  "KOSEF",
  "TIMEFOLIO",
  "PLUS",
  "레버리지",
  "인버스",
  "선물",
  "TR",
  "커버드콜",
  "액티브"
];

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeTradeAmount(value) {
  const tradeAmount = safeNumber(value);
  if (tradeAmount <= 0) return 0;
  return Math.log10(tradeAmount + 10) * 22;
}

function normalizeName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toUpperCase();
}

function isExchangeTradedProduct(stock) {
  const code = String(stock?.code || "").trim();
  const name = normalizeName(stock?.name);

  if (!/^\d{6}$/.test(code)) return true;

  return EXCLUDED_PRODUCT_KEYWORDS.some((keyword) => name.includes(keyword.toUpperCase()));
}

function buildReasonTags(stock, sector, sectorRank) {
  const tags = [];
  const tradeAmountMillion = safeNumber(stock.tradeAmountMillion);
  const changeRate = safeNumber(stock.changeRate);

  if (sectorRank <= 8) tags.push(`섹터 ${sectorRank}위`);
  if (tradeAmountMillion >= 100_000) tags.push("거래대금 1조+");
  else if (tradeAmountMillion >= 10_000) tags.push("거래대금 1천억+");
  else if (tradeAmountMillion >= 1_000) tags.push("거래대금 100억+");
  if (Math.abs(changeRate) >= 7) tags.push("급등락 7%+");
  if (stock.direction === "up") tags.push("상승 흐름");
  if (stock.direction === "down") tags.push("하락 압력");

  return tags.slice(0, 4);
}

function scoreCandidate(stock, sector, sectorRank, stockRank) {
  const tradeScore = normalizeTradeAmount(stock.tradeAmountMillion);
  const sectorScore = Math.max(0, 30 - sectorRank * 1.8);
  const stockRankScore = Math.max(0, 18 - stockRank * 2.4);
  const changeScore = Math.min(Math.abs(safeNumber(stock.changeRate)) * 1.5, 18);
  const breadthScore = safeNumber(sector.tradingValueMillion) > 0 ? 8 : 0;
  return tradeScore + sectorScore + stockRankScore + changeScore + breadthScore;
}

function candidateKey(stock) {
  return stock?.code || `${stock?.name || "unknown"}:${stock?.market || ""}`;
}

function boolEnv(name, fallback = false) {
  const value = String(process.env[name] || "").trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function normalizedProvider() {
  return String(process.env.PRECISION_API_PROVIDER || "kiwoom").trim().toLowerCase();
}

function getKisEnvStatus() {
  const hasKey = Boolean(String(process.env.KIS_APP_KEY || "").trim());
  const hasPin = Boolean(String(process.env.KIS_APP_SEC || "").trim());
  const hasAccount = Boolean(String(process.env.KIS_ACCOUNT_NO || "").trim());
  const configured = hasKey && hasPin && hasAccount;
  const requestedEnabled = boolEnv("KIS_ENABLED", false);
  const mode = String(process.env.KIS_MODE || "mock").trim().toLowerCase() === "prod" ? "prod" : "mock";

  return {
    configured,
    enabled: requestedEnabled && configured,
    requestedEnabled,
    mode: mode === "mock" ? "mock-trading" : "prod-trading",
    accountConfigured: hasAccount,
    restBaseUrl: process.env.KIS_REST_BASE_URL || process.env.KIS_BASE_URL || "not-configured",
    websocket: process.env.KIS_WS_URL || process.env.KIS_WEBSOCKET_URL ? "configured" : "not-configured",
    approvalKey: process.env.KIS_APPROVAL_KEY ? "configured" : "not-configured"
  };
}

export function getKiwoomEnvStatus() {
  const bridgeUrl = String(process.env.KIWOOM_BRIDGE_URL || "").trim();
  const tokenConfigured = Boolean(String(process.env.KIWOOM_BRIDGE_TOKEN || "").trim());
  const accountConfigured = Boolean(String(process.env.KIWOOM_ACCOUNT_NO || "").trim());
  const requestedEnabled = boolEnv("KIWOOM_ENABLED", false);
  const configured = Boolean(bridgeUrl);
  const enabled = requestedEnabled && configured;

  return {
    configured,
    enabled,
    requestedEnabled,
    mode: String(process.env.KIWOOM_MODE || "real").trim().toLowerCase(),
    bridgeUrl: bridgeUrl || "not-configured",
    tokenConfigured,
    accountConfigured,
    watchLimit: Number(process.env.KIWOOM_WATCH_LIMIT || process.env.PRECISION_WATCH_LIMIT || 40),
    screenNo: process.env.KIWOOM_SCREEN_NO || "9000",
    realFids: process.env.KIWOOM_REAL_FIDS || "10;13;14;15;20;228",
    healthPath: process.env.KIWOOM_HEALTH_PATH || "/health",
    streamPath: process.env.KIWOOM_STREAM_PATH || "/stream",
    registerPath: process.env.KIWOOM_REGISTER_PATH || "/register",
    note: enabled
      ? "Kiwoom local bridge is configured for selected precision-watch candidates."
      : "Set KIWOOM_ENABLED=true and KIWOOM_BRIDGE_URL in .env after starting the local Kiwoom bridge."
  };
}

export function buildPrecisionWatchlist(snapshot, options = {}) {
  const watchLimit = Math.max(1, Number(options.limit || DEFAULT_WATCH_LIMIT));
  const sourceTopSectors = Math.max(1, Number(options.sourceTopSectors || DEFAULT_SOURCE_TOP_SECTORS));
  const minTradeAmountMillion = Math.max(0, Number(options.minTradeAmountMillion ?? DEFAULT_MIN_TRADE_AMOUNT_MILLION));
  const byCode = new Map();
  let excludedProductCount = 0;

  (snapshot?.sectors || []).slice(0, sourceTopSectors).forEach((sector, sectorIndex) => {
    const sectorRank = sectorIndex + 1;
    (sector.topStocks || []).forEach((stock, stockIndex) => {
      if (!stock?.code || !stock?.name) return;
      if (isExchangeTradedProduct(stock)) {
        excludedProductCount += 1;
        return;
      }

      const tradeAmountMillion = safeNumber(stock.tradeAmountMillion);
      if (tradeAmountMillion < minTradeAmountMillion) return;

      const score = scoreCandidate(stock, sector, sectorRank, stockIndex + 1);
      const key = candidateKey(stock);
      const current = byCode.get(key);
      const candidate = {
        code: stock.code,
        name: stock.name,
        market: stock.market || "KRX",
        sectorId: sector.id,
        sectorName: sector.name,
        sectorRank,
        stockRank: stockIndex + 1,
        price: safeNumber(stock.price),
        changeRate: safeNumber(stock.changeRate),
        direction: stock.direction || "flat",
        tradeAmountMillion,
        naverUrl: stock.naverUrl,
        score: Number(score.toFixed(2)),
        reasonTags: buildReasonTags(stock, sector, sectorRank)
      };

      if (!current || candidate.score > current.score || candidate.tradeAmountMillion > current.tradeAmountMillion) {
        byCode.set(key, candidate);
      }
    });
  });

  const candidates = [...byCode.values()]
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return right.tradeAmountMillion - left.tradeAmountMillion;
    })
    .slice(0, watchLimit)
    .map((item, index) => ({ ...item, watchRank: index + 1 }));

  return {
    updatedAt: new Date().toISOString(),
    sourceUpdatedAt: snapshot?.updatedAt || null,
    mode: "broad-scan-selected-watchlist",
    broadScanProvider: snapshot?.provider || "Naver Finance",
    precisionProvider: `${normalizedProvider()}-adapter-pending`,
    marketScope: "KRX broad scan; NXT can be attached only through a broker/NXT market adapter",
    watchLimit,
    sourceTopSectors,
    minTradeAmountMillion,
    excludedProductCount,
    exclusionPolicy: {
      enabled: true,
      codeRule: "exclude non-6-digit numeric codes",
      keywords: EXCLUDED_PRODUCT_KEYWORDS
    },
    selectedCount: candidates.length,
    candidates,
    adapter: getPrecisionWatchAdapterStatus()
  };
}

export function getPrecisionWatchAdapterStatus() {
  const kis = getKisEnvStatus();
  const kiwoom = getKiwoomEnvStatus();
  const provider = normalizedProvider();
  const requestedEnabled = process.env.PRECISION_API_ENABLED === "true";
  const market = process.env.PRECISION_MARKET_SCOPE || "KRX_SELECTED";
  const enabled = requestedEnabled && (
    (provider === "kiwoom" && kiwoom.enabled) ||
    (provider === "kis" && kis.enabled)
  );

  return {
    enabled,
    requestedEnabled,
    provider,
    market,
    websocket: enabled ? "selected-watchlist-ready" : "not-configured",
    restPolling: enabled ? "fallback-ready" : "not-configured",
    kiwoom,
    kis,
    note: enabled
      ? `${provider.toUpperCase()} adapter is enabled for selected precision-watch candidates only.`
      : "Set PRECISION_API_ENABLED=true and configure the selected broker adapter in .env."
  };
}
