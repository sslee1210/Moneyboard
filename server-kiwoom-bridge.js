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

function numberEnv(names, fallback) {
  const keys = Array.isArray(names) ? names : [names];
  for (const key of keys) {
    const value = process.env[key];
    if (value === undefined || value === null || String(value).trim() === "") continue;
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return fallback;
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

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function joinUrl(base, route) {
  const root = String(base || "").replace(/\/+$/, "");
  const suffix = String(route || "").startsWith("/") ? route : `/${route}`;
  return `${root}${suffix}`;
}

function withCodesQuery(route, codes) {
  if (!codes.length || route.includes("?")) return route;
  return `${route}?codes=${encodeURIComponent(codes.join(","))}`;
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

function getLatestPathCandidates() {
  return unique([
    process.env.KIWOOM_LATEST_PATH,
    "/latest",
    "/quotes",
    "/api/latest",
    "/api/quotes",
    "/realtime",
    "/api/realtime",
    "/snapshot",
    "/api/snapshot"
  ]);
}

function getHealthPath() {
  return process.env.KIWOOM_HEALTH_PATH || "/health";
}

function valuesWithCode(object) {
  if (!object || typeof object !== "object" || Array.isArray(object)) return [];
  return Object.entries(object).map(([key, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value)) return { code: key, ...value };
    return { code: key, value };
  });
}

function unwrapQuoteContainer(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.latest)) return payload;
  if (Array.isArray(payload.quotes)) return payload;
  if (Array.isArray(payload.items)) return payload;
  if (Array.isArray(payload.data)) return payload;
  if (Array.isArray(payload.stocks)) return payload;

  const keyed = [
    ...valuesWithCode(payload.latest),
    ...valuesWithCode(payload.quotes),
    ...valuesWithCode(payload.byCode),
    ...valuesWithCode(payload.data),
    ...valuesWithCode(payload.stocks),
    ...valuesWithCode(payload.latestByCode),
    ...valuesWithCode(payload.quoteByCode)
  ];
  if (keyed.length) return keyed;

  const direct = valuesWithCode(payload);
  return direct.some((item) => normalizeCode(item.code)) ? direct : [];
}

function pickFirst(record, keys) {
  for (const key of keys) {
    if (record?.[key] !== undefined && record?.[key] !== null && record?.[key] !== "") return record[key];
  }
  return undefined;
}

function flattenRecord(record) {
  if (!record || typeof record !== "object") return record;
  return {
    ...record,
    ...(record.fids && typeof record.fids === "object" ? record.fids : {}),
    ...(record.realData && typeof record.realData === "object" ? record.realData : {}),
    ...(record.data && typeof record.data === "object" && !Array.isArray(record.data) ? record.data : {})
  };
}

function getKiwoomPriceScale() {
  return numberEnv(["KIWOOM_PRICE_SCALE"], 1);
}

function getKiwoomTradeAmountMillionScale() {
  return numberEnv(["KIWOOM_TRADE_AMOUNT_MILLION_SCALE", "KIWOOM_TRADE_AMOUNT_SCALE"], 0.1);
}

function normalizePrice(rawValue) {
  const raw = Math.abs(toFiniteNumber(rawValue, 0));
  return Math.round(raw * getKiwoomPriceScale());
}

function normalizeTradeAmountMillion(rawValue, price, volume) {
  const raw = Math.abs(toFiniteNumber(rawValue, 0));
  const scale = getKiwoomTradeAmountMillionScale();
  const computed = price > 0 && volume > 0 ? Math.round((price * volume) / 1_000_000) : 0;

  if (raw > 0) {
    return {
      value: Math.round(raw * scale),
      raw,
      scale,
      computed,
      source: "kiwoom-fid14",
      note: "Kiwoom FID 14 raw value converted to million KRW using KIWOOM_TRADE_AMOUNT_MILLION_SCALE."
    };
  }

  return {
    value: computed,
    raw,
    scale,
    computed,
    source: "price-volume-fallback",
    note: "FID 14 was empty, so trade amount was computed from price and volume."
  };
}

function normalizeQuote(input) {
  const record = flattenRecord(input);
  const code = normalizeCode(pickFirst(record, ["code", "stockCode", "symbol", "종목코드", "9001", "9001_code"]));
  if (!code) return null;

  const rawPrice = pickFirst(record, ["price", "currentPrice", "close", "현재가", "10", "fid10"]);
  const price = normalizePrice(rawPrice);
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
  const normalizedTradeAmount = normalizeTradeAmountMillion(rawTradeAmount, price, volume);
  const changeRate = toFiniteNumber(pickFirst(record, ["changeRate", "rate", "등락률", "12", "fid12"]), 0);

  return {
    code,
    name: compactText(pickFirst(record, ["name", "stockName", "종목명"])) || null,
    price,
    rawPrice: toFiniteNumber(rawPrice, 0),
    priceScale: getKiwoomPriceScale(),
    volume,
    tradeAmountMillion: normalizedTradeAmount.value,
    rawTradeAmount: normalizedTradeAmount.raw,
    computedTradeAmountMillion: normalizedTradeAmount.computed,
    tradeAmountScale: normalizedTradeAmount.scale,
    tradeAmountSource: normalizedTradeAmount.source,
    tradeAmountNote: normalizedTradeAmount.note,
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
    .filter(Boolean)
    .filter((quote) => quote.price > 0 || quote.volume > 0 || quote.tradeAmountMillion > 0);
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
    latestPathCandidates: getLatestPathCandidates(),
    healthPath: getHealthPath(),
    priceScale: getKiwoomPriceScale(),
    tradeAmountMillionScale: getKiwoomTradeAmountMillionScale(),
    tradeAmountBasis: "kiwoom-fid14-fixed-scale",
    ...extra
  };
}

async function registerWatchlist(candidates) {
  const status = getKiwoomBridgeRuntimeStatus();
  if (!status.enabled) return { ...status, registered: false, reason: "disabled" };

  const codes = unique((candidates || []).map((item) => normalizeCode(item.code))).slice(
    0,
    Number(process.env.KIWOOM_WATCH_LIMIT || process.env.PRECISION_WATCH_LIMIT || 40)
  );
  const key = codes.join(",");
  if (!codes.length) return { ...status, registered: false, reason: "empty-watchlist" };
  if (registerCache.key === key && registerCache.status && registerCache.expiresAt > Date.now()) return registerCache.status;
  if (registerCache.key === key && registerCache.promise) return registerCache.promise;

  const body = {
    codes,
    fids: process.env.KIWOOM_REAL_FIDS || "10;12;13;14;15;20;228",
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

async function readHealth() {
  try {
    return await fetchBridgeJson(getHealthPath());
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function loadLatestQuotes(candidates) {
  const status = getKiwoomBridgeRuntimeStatus();
  if (!status.enabled) return { quotesByCode: new Map(), status };

  const codes = unique((candidates || []).map((item) => normalizeCode(item.code)));
  const key = codes.join(",");
  if (latestCache.key === key && latestCache.expiresAt > Date.now() && latestCache.status) {
    return { quotesByCode: latestCache.data, status: latestCache.status };
  }
  if (latestCache.key === key && latestCache.promise) return latestCache.promise;

  latestCache.key = key;
  latestCache.promise = (async () => {
    const registerStatus = await registerWatchlist(candidates);
    const attempts = [];

    for (const baseRoute of getLatestPathCandidates()) {
      for (const route of unique([baseRoute, withCodesQuery(baseRoute, codes)])) {
        try {
          const payload = await fetchBridgeJson(route);
          const quotesByCode = normalizeQuotes(payload);
          attempts.push({ route, ok: true, quoteCount: quotesByCode.size });

          if (quotesByCode.size > 0) {
            const nextStatus = {
              ...status,
              ...registerStatus,
              latestPath: route,
              latestCount: quotesByCode.size,
              quoteCodes: [...quotesByCode.keys()],
              attempts,
              updatedAt: new Date().toISOString()
            };
            latestCache.data = quotesByCode;
            latestCache.status = nextStatus;
            latestCache.expiresAt = Date.now() + KIWOOM_POLL_CACHE_MS;
            latestCache.promise = null;
            return { quotesByCode, status: nextStatus };
          }
        } catch (error) {
          attempts.push({ route, ok: false, error: error.message });
        }
      }
    }

    const health = await readHealth();
    const nextStatus = {
      ...status,
      ...registerStatus,
      latestPath: null,
      latestCount: 0,
      quoteCodes: [],
      attempts,
      health,
      error: "No Kiwoom latest quote endpoint returned usable quote data.",
      updatedAt: new Date().toISOString()
    };
    latestCache.data = new Map();
    latestCache.status = nextStatus;
    latestCache.expiresAt = Date.now() + KIWOOM_POLL_CACHE_MS;
    latestCache.promise = null;
    return { quotesByCode: new Map(), status: nextStatus };
  })();

  return latestCache.promise;
}

export async function enrichSnapshotWithKiwoom(snapshot, precisionWatchlist = snapshot?.precisionWatchlist) {
  const candidates = precisionWatchlist?.candidates || [];
  const { quotesByCode, status } = await loadLatestQuotes(candidates);

  const nextCandidates = candidates.map((candidate) => {
    const quote = quotesByCode.get(candidate.code);
    if (!quote) return candidate;
    return {
      ...candidate,
      name: quote.name || candidate.name,
      price: quote.price || candidate.price,
      rawPrice: quote.rawPrice,
      priceScale: quote.priceScale,
      volume: quote.volume || candidate.volume,
      tradeAmountMillion: quote.tradeAmountMillion || candidate.tradeAmountMillion,
      rawTradeAmount: quote.rawTradeAmount,
      computedTradeAmountMillion: quote.computedTradeAmountMillion,
      tradeAmountScale: quote.tradeAmountScale,
      tradeAmountSource: quote.tradeAmountSource,
      tradeAmountNote: quote.tradeAmountNote,
      changeRate: Number.isFinite(quote.changeRate) ? quote.changeRate : candidate.changeRate,
      direction: quote.direction || candidate.direction,
      provider: quote.provider,
      live: true,
      liveUpdatedAt: quote.liveUpdatedAt
    };
  });

  const liveQuoteCount = nextCandidates.filter((candidate) => candidate.live).length;
  const nextWatchlist = {
    ...precisionWatchlist,
    updatedAt: new Date().toISOString(),
    precisionProvider: liveQuoteCount > 0 ? "kiwoom-bridge-live" : "kiwoom-adapter-pending",
    liveQuoteCount,
    candidates: nextCandidates,
    adapter: {
      ...(precisionWatchlist?.adapter || {}),
      kiwoomBridge: status
    }
  };

  return {
    snapshot: {
      ...snapshot,
      provider: liveQuoteCount > 0 ? "Kiwoom OpenAPI+ bridge + Naver Finance" : snapshot?.provider,
      precisionWatchlist: nextWatchlist
    },
    quotesByCode,
    status
  };
}
