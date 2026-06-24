const KIWOOM_POLL_CACHE_MS = Number(process.env.KIWOOM_POLL_CACHE_MS || process.env.KIWOOM_REALTIME_PUSH_MS || 1000);
const KIWOOM_REGISTER_CACHE_MS = Number(process.env.KIWOOM_REGISTER_REFRESH_MS || 3000);
const KIWOOM_TIMEOUT_MS = Number(process.env.KIWOOM_TIMEOUT_MS || 5000);

const latestCache = { key: "", data: new Map(), status: null, expiresAt: 0, promise: null };
const registerCache = { key: "", status: null, expiresAt: 0, promise: null };

function boolEnv(name, fallback = false) {
  const value = String(process.env[name] || "").trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function compactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function toFiniteNumber(value, fallback = 0) {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  const normalized = compactText(value)
    .replace(/[+,]/g, "")
    .replace(/[▲△]/g, "")
    .replace(/[▼▽]/g, "-")
    .replace(/[^\d.-]/g, "");
  if (!normalized || normalized === "-" || normalized === ".") return fallback;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeCode(value) {
  const text = compactText(value).replace(/^A/i, "");
  const match = text.match(/\d{6}/);
  return match ? match[0] : "";
}

function joinUrl(base, route) {
  const root = String(base || "").replace(/\/+$/, "");
  const suffix = String(route || "").startsWith("/") ? route : `/${route}`;
  return `${root}${suffix}`;
}

function authHeaders(extra = {}) {
  const headers = { ...extra };
  if (process.env.KIWOOM_BRIDGE_TOKEN) headers.Authorization = `Bearer ${process.env.KIWOOM_BRIDGE_TOKEN}`;
  return headers;
}

async function fetchBridgeJson(route, options = {}) {
  const bridgeUrl = String(process.env.KIWOOM_BRIDGE_URL || "").trim();
  if (!bridgeUrl) throw new Error("KIWOOM_BRIDGE_URL is not configured");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || KIWOOM_TIMEOUT_MS));

  try {
    const response = await fetch(joinUrl(bridgeUrl, route), {
      ...options,
      signal: controller.signal,
      headers: authHeaders({
        accept: "application/json,text/plain,*/*",
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.headers || {})
      })
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Kiwoom bridge ${route} responded ${response.status}: ${text.slice(0, 200)}`);
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  } finally {
    clearTimeout(timeout);
  }
}

function getPathCandidates() {
  return [
    process.env.KIWOOM_LATEST_PATH,
    "/latest",
    "/quotes",
    "/api/latest",
    "/api/quotes",
    process.env.KIWOOM_HEALTH_PATH || "/health"
  ].filter(Boolean);
}

function unwrapQuoteContainer(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.latest)) return payload.latest;
  if (Array.isArray(payload.quotes)) return payload.quotes;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.stocks)) return payload.stocks;
  if (payload.latest && typeof payload.latest === "object") return Object.values(payload.latest);
  if (payload.quotes && typeof payload.quotes === "object") return Object.values(payload.quotes);
  if (payload.byCode && typeof payload.byCode === "object") return Object.values(payload.byCode);
  if (payload.data && typeof payload.data === "object") return Object.values(payload.data);
  return [];
}

function pickFirst(record, keys) {
  for (const key of keys) {
    if (record?.[key] !== undefined && record?.[key] !== null && record?.[key] !== "") return record[key];
  }
  return undefined;
}

function normalizeTradeAmountMillion(rawValue, price, volume) {
  const raw = toFiniteNumber(rawValue, 0);
  const computed = price > 0 && volume > 0 ? Math.round((price * volume) / 1_000_000) : 0;

  if (raw <= 0) return computed;

  // Kiwoom bridges differ: some send KRW, some send thousand/million KRW.
  const candidates = [raw, raw / 1_000, raw / 1_000_000, raw * 1_000, raw * 10_000]
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.round(value));

  if (!computed) return candidates.find((value) => value > 0) || 0;

  return candidates.sort((left, right) => Math.abs(left - computed) - Math.abs(right - computed))[0] || computed;
}

function normalizeQuote(record) {
  const code = normalizeCode(pickFirst(record, ["code", "stockCode", "symbol", "종목코드", "9001", "9001_code"]));
  if (!code) return null;

  const price = Math.abs(toFiniteNumber(pickFirst(record, ["price", "currentPrice", "close", "현재가", "10", "fid10"]), 0));
  const volume = Math.abs(toFiniteNumber(pickFirst(record, ["volume", "accVolume", "cumulativeVolume", "거래량", "누적거래량", "13", "fid13"]), 0));
  const rawTradeAmount = pickFirst(record, [
    "tradeAmountMillion",
    "tradingValueMillion",
    "tradeAmount",
    "tradingValue",
    "accTradeAmount",
    "누적거래대금",
    "거래대금",
    "14",
    "fid14"
  ]);
  const tradeAmountMillion = normalizeTradeAmountMillion(rawTradeAmount, price, volume);
  const changeRate = toFiniteNumber(pickFirst(record, ["changeRate", "rate", "등락률", "12", "fid12"]), 0);

  return {
    code,
    name: compactText(pickFirst(record, ["name", "stockName", "종목명"])) || null,
    price,
    volume,
    tradeAmountMillion,
    changeRate,
    direction: changeRate > 0 ? "up" : changeRate < 0 ? "down" : "flat",
    provider: "Kiwoom OpenAPI+ bridge",
    live: true,
    liveUpdatedAt: pickFirst(record, ["updatedAt", "time", "timestamp", "lastEventAt", "20", "fid20"]) || new Date().toISOString()
  };
}

function normalizeQuotes(payload) {
  const quotes = unwrapQuoteContainer(payload)
    .map(normalizeQuote)
    .filter(Boolean);
  return new Map(quotes.map((quote) => [quote.code, quote]));
}

export function getKiwoomBridgeRuntimeStatus(extra = {}) {
  const bridgeUrl = String(process.env.KIWOOM_BRIDGE_URL || "").trim();
  const requestedEnabled = boolEnv("KIWOOM_ENABLED", false) || boolEnv("PRECISION_API_ENABLED", false);
  const configured = Boolean(bridgeUrl);
  return {
    configured,
    enabled: requestedEnabled && configured,
    requestedEnabled,
    bridgeUrl: bridgeUrl || "not-configured",
    pollCacheMs: KIWOOM_POLL_CACHE_MS,
    registerCacheMs: KIWOOM_REGISTER_CACHE_MS,
    latestPathCandidates: getPathCandidates(),
    ...extra
  };
}

async function registerWatchlist(candidates) {
  const status = getKiwoomBridgeRuntimeStatus();
  if (!status.enabled) return { ...status, registered: false, reason: "disabled" };

  const codes = [...new Set((candidates || []).map((item) => normalizeCode(item.code)).filter(Boolean))].slice(
    0,
    Number(process.env.KIWOOM_WATCH_LIMIT || process.env.PRECISION_WATCH_LIMIT || 40)
  );
  const key = codes.join(",");
  if (!codes.length) return { ...status, registered: false, reason: "empty-watchlist" };
  if (registerCache.key === key && registerCache.status && registerCache.expiresAt > Date.now()) return registerCache.status;
  if (registerCache.key === key && registerCache.promise) return registerCache.promise;

  const body = {
    codes,
    fids: process.env.KIWOOM_REAL_FIDS || "10;13;14;15;20;228",
    screenNo: process.env.KIWOOM_SCREEN_NO || "9000"
  };

  const registerPath = process.env.KIWOOM_REGISTER_PATH || "/register";
  registerCache.key = key;
  registerCache.promise = fetchBridgeJson(registerPath, {
    method: "POST",
    body: JSON.stringify(body)
  })
    .then((payload) => ({
      ...status,
      registered: true,
      registerPath,
      registeredCount: codes.length,
      registeredCodes: codes,
      bridgeResponse: payload,
      updatedAt: new Date().toISOString()
    }))
    .catch((error) => ({
      ...status,
      registered: false,
      registerPath,
      registeredCount: 0,
      registeredCodes: [],
      error: error.message,
      updatedAt: new Date().toISOString()
    }))
    .then((nextStatus) => {
      registerCache.status = nextStatus;
      registerCache.expiresAt = Date.now() + KIWOOM_REGISTER_CACHE_MS;
      registerCache.promise = null;
      return nextStatus;
    });

  return registerCache.promise;
}

async function loadLatestQuotes(candidates) {
  const status = getKiwoomBridgeRuntimeStatus();
  if (!status.enabled) return { quotesByCode: new Map(), status };

  const codes = [...new Set((candidates || []).map((item) => normalizeCode(item.code)).filter(Boolean))];
  const key = codes.join(",");
  if (latestCache.key === key && latestCache.expiresAt > Date.now() && latestCache.status) {
    return { quotesByCode: latestCache.data, status: latestCache.status };
  }
  if (latestCache.key === key && latestCache.promise) return latestCache.promise;

  latestCache.key = key;
  latestCache.promise = (async () => {
    const registerStatus = await registerWatchlist(candidates);
    let lastError = null;

    for (const route of getPathCandidates()) {
      try {
        const payload = await fetchBridgeJson(route);
        const quotesByCode = normalizeQuotes(payload);
        const nextStatus = {
          ...status,
          ...registerStatus,
          latestPath: route,
          latestCount: quotesByCode.size,
          quoteCodes: [...quotesByCode.keys()],
          updatedAt: new Date().toISOString()
        };
        latestCache.data = quotesByCode;
        latestCache.status = nextStatus;
        latestCache.expiresAt = Date.now() + KIWOOM_POLL_CACHE_MS;
        latestCache.promise = null;
        return { quotesByCode, status: nextStatus };
      } catch (error) {
        lastError = error;
      }
    }

    const errorStatus = {
      ...status,
      ...registerStatus,
      latestCount: 0,
      error: lastError?.message || "No Kiwoom latest quote endpoint responded",
      updatedAt: new Date().toISOString()
    };
    latestCache.data = new Map();
    latestCache.status = errorStatus;
    latestCache.expiresAt = Date.now() + Math.min(KIWOOM_POLL_CACHE_MS, 1000);
    latestCache.promise = null;
    return { quotesByCode: latestCache.data, status: errorStatus };
  })();

  return latestCache.promise;
}

function mergeQuoteIntoStock(stock, quote) {
  if (!quote) return stock;
  const next = { ...stock };
  if (quote.name) next.name = quote.name;
  if (quote.price > 0) next.price = quote.price;
  if (quote.volume > 0) next.volume = quote.volume;
  if (quote.tradeAmountMillion > 0) next.tradeAmountMillion = quote.tradeAmountMillion;
  if (Number.isFinite(quote.changeRate)) next.changeRate = quote.changeRate;
  next.direction = quote.direction || next.direction;
  next.provider = quote.provider;
  next.live = true;
  next.liveUpdatedAt = quote.liveUpdatedAt;
  return next;
}

function recalculateSector(sector) {
  const stocks = [...(sector.stocks || [])].sort((left, right) => (right.tradeAmountMillion || 0) - (left.tradeAmountMillion || 0));
  const topStocks = stocks.slice(0, 8);
  const tradingValueMillion = stocks.reduce((sum, stock) => sum + (stock.tradeAmountMillion || 0), 0);
  const volume = stocks.reduce((sum, stock) => sum + (stock.volume || 0), 0);
  const weightedChangeRate = tradingValueMillion > 0
    ? stocks.reduce((sum, stock) => sum + (stock.changeRate || 0) * (stock.tradeAmountMillion || 0), 0) / tradingValueMillion
    : sector.weightedChangeRate || sector.changeRate || 0;
  const topStock = topStocks[0] || null;

  return {
    ...sector,
    stocks,
    topStocks,
    topStockName: topStock?.name || null,
    topStockCode: topStock?.code || null,
    tradingValueMillion,
    volume,
    weightedChangeRate
  };
}

export async function enrichSnapshotWithKiwoom(snapshot, watchlist) {
  const candidates = watchlist?.candidates || [];
  const { quotesByCode, status } = await loadLatestQuotes(candidates);
  if (!quotesByCode.size) {
    return {
      snapshot: {
        ...snapshot,
        precisionWatchlist: {
          ...watchlist,
          adapter: { ...(watchlist?.adapter || {}), kiwoomBridge: status }
        }
      },
      status
    };
  }

  const sectors = (snapshot.sectors || []).map((sector) => {
    const stocks = (sector.stocks || sector.topStocks || []).map((stock) => mergeQuoteIntoStock(stock, quotesByCode.get(stock.code)));
    return recalculateSector({ ...sector, stocks });
  }).sort((left, right) => (right.tradingValueMillion || 0) - (left.tradingValueMillion || 0));

  const totals = {
    ...(snapshot.totals || {}),
    tradingValueMillion: sectors.reduce((sum, sector) => sum + (sector.tradingValueMillion || 0), 0),
    volume: sectors.reduce((sum, sector) => sum + (sector.volume || 0), 0)
  };

  const liveCandidates = (watchlist?.candidates || []).map((candidate) => mergeQuoteIntoStock(candidate, quotesByCode.get(candidate.code)));

  return {
    snapshot: {
      ...snapshot,
      updatedAt: new Date().toISOString(),
      provider: quotesByCode.size ? "Naver Finance + Kiwoom OpenAPI+ bridge" : snapshot.provider,
      totals,
      sectors,
      precisionWatchlist: {
        ...watchlist,
        precisionProvider: "kiwoom-bridge",
        liveQuoteCount: quotesByCode.size,
        candidates: liveCandidates,
        adapter: { ...(watchlist?.adapter || {}), kiwoomBridge: status }
      }
    },
    status
  };
}
