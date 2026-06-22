import fs from "node:fs";
import path from "node:path";

function loadLocalEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;

    const separator = trimmed.indexOf("=");
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (!key || process.env[key] !== undefined) continue;

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

loadLocalEnv();

function boolEnv(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return /^(1|true|yes|y|on)$/i.test(String(value).trim());
}

function numericEnv(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function parseNumber(value) {
  const normalized = String(value ?? "")
    .replace(/,/g, "")
    .replace(/[^\d.-]/g, "");
  if (!normalized || normalized === "-" || normalized === ".") return 0;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function normalizeEnv(value) {
  const clean = String(value || "real").trim().toLowerCase();
  if (["demo", "mock", "vps", "paper", "virtual"].includes(clean)) return "demo";
  return "real";
}

function maskSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return `${text.slice(0, 2)}***`;
  return `${text.slice(0, 4)}***${text.slice(-4)}`;
}

export const KIS_ENV = normalizeEnv(process.env.KIS_ENV);
export const KIS_APP_KEY = process.env.KIS_APP_KEY || "";
export const KIS_APP_SECRET = process.env.KIS_APP_SECRET || "";
export const KIS_ACCOUNT_NO = process.env.KIS_ACCOUNT_NO || "";
export const KIS_ACCOUNT_PRODUCT_CODE = process.env.KIS_ACCOUNT_PRODUCT_CODE || "";
export const KIS_HTS_ID = process.env.KIS_HTS_ID || "";
export const KIS_BASE_URL =
  process.env.KIS_BASE_URL ||
  (KIS_ENV === "demo"
    ? "https://openapivts.koreainvestment.com:29443"
    : "https://openapi.koreainvestment.com:9443");
export const KIS_MARKET_DIV_CODE = process.env.KIS_MARKET_DIV_CODE || "J";
export const KIS_QUOTE_CACHE_MS = numericEnv(process.env.KIS_QUOTE_CACHE_MS, 15_000);
export const KIS_REQUEST_TIMEOUT_MS = numericEnv(process.env.KIS_REQUEST_TIMEOUT_MS, 8_000);
export const KIS_STOCK_CONCURRENCY = Math.max(1, numericEnv(process.env.KIS_STOCK_CONCURRENCY, 2));
export const KIS_MARKET_VERIFY_TOP_SECTORS = Math.max(
  0,
  numericEnv(process.env.KIS_MARKET_VERIFY_TOP_SECTORS, 12)
);
export const KIS_MARKET_VERIFY_TOP_STOCKS = Math.max(
  0,
  numericEnv(process.env.KIS_MARKET_VERIFY_TOP_STOCKS, 8)
);
export const KIS_SELECTED_SECTOR_STOCKS = Math.max(
  0,
  numericEnv(process.env.KIS_SELECTED_SECTOR_STOCKS, 20)
);

const hasCredentials = Boolean(KIS_APP_KEY && KIS_APP_SECRET);
export const KIS_ENABLED = boolEnv(process.env.KIS_ENABLED, false) && hasCredentials;

const tokenCache = { token: "", expiresAt: 0, promise: null };
const quoteCache = new Map();

function sortStocksByTradingValue(stocks = []) {
  return [...stocks].sort((left, right) => {
    const tradingGap = (right.tradeAmountMillion || 0) - (left.tradeAmountMillion || 0);
    if (tradingGap !== 0) return tradingGap;
    return (right.volume || 0) - (left.volume || 0);
  });
}

function countOrderErrors(items, field) {
  let errors = 0;
  for (let index = 1; index < items.length; index += 1) {
    if ((items[index - 1]?.[field] || 0) < (items[index]?.[field] || 0)) errors += 1;
  }
  return errors;
}

function estimateTradeAmountMillion(price, volume) {
  const estimate = (Number(price || 0) * Number(volume || 0)) / 1_000_000;
  return Number.isFinite(estimate) && estimate > 0 ? estimate : 0;
}

function applyKisSign(value, sign) {
  const number = parseNumber(value);
  const cleanSign = String(sign || "").trim();
  if (["4", "5"].includes(cleanSign)) return -Math.abs(number);
  if (["1", "2"].includes(cleanSign)) return Math.abs(number);
  if (cleanSign === "3") return 0;
  return number;
}

async function mapLimit(items, limit, mapper) {
  const results = [];
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), KIS_REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function parseTokenExpiry(json) {
  const explicit = String(json?.access_token_token_expired || "").trim();
  if (explicit) {
    const parsed = Date.parse(explicit.replace(" ", "T"));
    if (Number.isFinite(parsed)) return parsed - 60_000;
  }

  const expiresIn = Number(json?.expires_in || 0);
  if (Number.isFinite(expiresIn) && expiresIn > 0) return Date.now() + expiresIn * 1000 - 60_000;
  return Date.now() + 23 * 60 * 60 * 1000;
}

export function getKisStatus() {
  return {
    configured: hasCredentials,
    enabled: KIS_ENABLED,
    env: KIS_ENV,
    baseUrl: KIS_BASE_URL,
    marketDivCode: KIS_MARKET_DIV_CODE,
    appKey: maskSecret(KIS_APP_KEY),
    accountConfigured: Boolean(KIS_ACCOUNT_NO && KIS_ACCOUNT_PRODUCT_CODE),
    htsIdConfigured: Boolean(KIS_HTS_ID),
    quoteCacheMs: KIS_QUOTE_CACHE_MS,
    marketVerifyTopSectors: KIS_MARKET_VERIFY_TOP_SECTORS,
    marketVerifyTopStocks: KIS_MARKET_VERIFY_TOP_STOCKS,
    selectedSectorStocks: KIS_SELECTED_SECTOR_STOCKS,
    quoteCacheSize: quoteCache.size,
    tokenCached: Boolean(tokenCache.token && tokenCache.expiresAt > Date.now())
  };
}

export async function getKisToken({ force = false } = {}) {
  if (!KIS_ENABLED) {
    throw new Error(
      hasCredentials ? "KIS_ENABLED is not true" : "KIS_APP_KEY/KIS_APP_SECRET are not configured"
    );
  }

  if (!force && tokenCache.token && tokenCache.expiresAt > Date.now()) return tokenCache.token;
  if (!force && tokenCache.promise) return tokenCache.promise;

  const promise = (async () => {
    const response = await fetchWithTimeout(`${KIS_BASE_URL}/oauth2/tokenP`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        grant_type: "client_credentials",
        appkey: KIS_APP_KEY,
        appsecret: KIS_APP_SECRET
      })
    });

    const json = await response.json().catch(() => ({}));
    if (!response.ok || !json.access_token) {
      throw new Error(`KIS token request failed: HTTP ${response.status} ${json.msg1 || json.error_description || ""}`.trim());
    }

    tokenCache.token = json.access_token;
    tokenCache.expiresAt = parseTokenExpiry(json);
    return tokenCache.token;
  })();

  tokenCache.promise = promise;
  try {
    return await promise;
  } finally {
    tokenCache.promise = null;
  }
}

async function fetchKisApi(pathname, trId, params, { retry = true } = {}) {
  const token = await getKisToken();
  const url = new URL(pathname, KIS_BASE_URL);
  for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, value);

  const response = await fetchWithTimeout(url.toString(), {
    headers: {
      accept: "application/json",
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
      appkey: KIS_APP_KEY,
      appsecret: KIS_APP_SECRET,
      tr_id: trId,
      custtype: "P"
    }
  });

  const json = await response.json().catch(() => ({}));
  if (response.status === 401 && retry) {
    tokenCache.token = "";
    tokenCache.expiresAt = 0;
    await getKisToken({ force: true });
    return fetchKisApi(pathname, trId, params, { retry: false });
  }

  if (!response.ok) {
    throw new Error(`KIS API HTTP ${response.status}: ${json.msg1 || json.error_description || pathname}`);
  }

  if (json.rt_cd && json.rt_cd !== "0") {
    throw new Error(`KIS API ${json.msg_cd || "error"}: ${json.msg1 || "request failed"}`);
  }

  return json;
}

function normalizeKisQuote(code, output = {}) {
  const price = parseNumber(output.stck_prpr);
  const volume = parseNumber(output.acml_vol);
  const tradeAmountWon = parseNumber(output.acml_tr_pbmn);
  const derivedTradeAmountMillion = estimateTradeAmountMillion(price, volume);
  const tradeAmountMillion =
    tradeAmountWon > 0 ? tradeAmountWon / 1_000_000 : derivedTradeAmountMillion;
  const sign = output.prdy_vrss_sign;
  const changeAmount = applyKisSign(output.prdy_vrss, sign);
  const changeRate = applyKisSign(output.prdy_ctrt, sign);

  return {
    code: String(code || output.stck_shrn_iscd || "").padStart(6, "0"),
    name: output.hts_kor_isnm || output.prdt_abrv_name || "",
    price,
    changeAmount,
    changeRate,
    volume,
    tradeAmountMillion,
    tradeAmountWon,
    source: "KIS Open API",
    marketDivCode: KIS_MARKET_DIV_CODE,
    raw: {
      prdyVrssSign: output.prdy_vrss_sign,
      acmlTrPbmn: output.acml_tr_pbmn,
      stckPrpr: output.stck_prpr,
      acmlVol: output.acml_vol
    },
    updatedAt: new Date().toISOString()
  };
}

export async function fetchKisQuote(code, options = {}) {
  if (!KIS_ENABLED) throw new Error("KIS provider is disabled");
  const normalizedCode = String(code || "").replace(/\D/g, "").padStart(6, "0").slice(-6);
  if (!/^\d{6}$/.test(normalizedCode)) throw new Error(`Invalid KIS stock code: ${code}`);

  const cached = quoteCache.get(normalizedCode);
  if (!options.force && cached?.data && cached.expiresAt > Date.now()) return cached.data;
  if (!options.force && cached?.promise) return cached.promise;

  const promise = fetchKisApi("/uapi/domestic-stock/v1/quotations/inquire-price", "FHKST01010100", {
    FID_COND_MRKT_DIV_CODE: KIS_MARKET_DIV_CODE,
    FID_INPUT_ISCD: normalizedCode
  }).then((json) => normalizeKisQuote(normalizedCode, json.output || {}));

  quoteCache.set(normalizedCode, { data: cached?.data || null, expiresAt: 0, promise });
  try {
    const data = await promise;
    quoteCache.set(normalizedCode, {
      data,
      expiresAt: Date.now() + KIS_QUOTE_CACHE_MS,
      promise: null
    });
    return data;
  } catch (error) {
    quoteCache.set(normalizedCode, {
      data: cached?.data || null,
      expiresAt: Date.now() + Math.min(KIS_QUOTE_CACHE_MS, 5_000),
      promise: null,
      error: error.message
    });
    if (cached?.data) return cached.data;
    throw error;
  }
}

function mergeKisQuote(stock, quote) {
  const tradeAmountMillion =
    quote.tradeAmountMillion > 0
      ? quote.tradeAmountMillion
      : estimateTradeAmountMillion(quote.price || stock.price, quote.volume || stock.volume);

  return {
    ...stock,
    name: stock.name || quote.name,
    price: quote.price || stock.price,
    changeAmount: Number.isFinite(quote.changeAmount) ? quote.changeAmount : stock.changeAmount,
    changeRate: Number.isFinite(quote.changeRate) ? quote.changeRate : stock.changeRate,
    volume: quote.volume || stock.volume,
    tradeAmountMillion: tradeAmountMillion || stock.tradeAmountMillion,
    kisTradeAmountMillion: tradeAmountMillion,
    kisQuote: quote,
    dataProvider: "KIS",
    tradingValueValidation: {
      ...(stock.tradingValueValidation || {}),
      status: "kis-verified",
      source: "KIS Open API",
      previousStatus: stock.tradingValueValidation?.status || "unknown",
      marketDivCode: quote.marketDivCode,
      updatedAt: quote.updatedAt
    }
  };
}

function countByValidationStatus(stocks = []) {
  return stocks.reduce((acc, stock) => {
    const status = stock.tradingValueValidation?.status || "unknown";
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
}

function recalculateSector(sector, kisErrors = []) {
  const stocks = sortStocksByTradingValue(sector.stocks || []);
  const volumeStocks = [...stocks].sort((left, right) => {
    const volumeGap = (right.volume || 0) - (left.volume || 0);
    if (volumeGap !== 0) return volumeGap;
    return (right.tradeAmountMillion || 0) - (left.tradeAmountMillion || 0);
  });
  const tradingValueMillion = stocks.reduce((sum, stock) => sum + (stock.tradeAmountMillion || 0), 0);
  const volume = stocks.reduce((sum, stock) => sum + (stock.volume || 0), 0);
  const weightedChangeRate =
    tradingValueMillion > 0
      ? stocks.reduce((sum, stock) => sum + (stock.changeRate || 0) * (stock.tradeAmountMillion || 0), 0) /
        tradingValueMillion
      : sector.changeRate;
  const validationStatusCounts = countByValidationStatus(stocks);
  const repairedTradeAmountCount =
    (validationStatusCounts["repaired-price-volume"] || 0) +
    (validationStatusCounts["parsed-candidate"] || 0);
  const derivedTradeAmountCount = validationStatusCounts["derived-price-volume"] || 0;
  const unverifiedTradeAmountCount = validationStatusCounts.unverified || 0;
  const kisVerifiedCount = validationStatusCounts["kis-verified"] || 0;
  const stockOrderErrorCount = countOrderErrors(stocks, "tradeAmountMillion");

  return {
    ...sector,
    tradingValueMillion,
    volume,
    weightedChangeRate,
    stocks,
    topStocks: stocks.slice(0, 8),
    topTradingValueStocks: stocks.slice(0, 8),
    topVolumeStocks: volumeStocks.slice(0, 8),
    validationStatusCounts,
    repairedTradeAmountCount,
    derivedTradeAmountCount,
    unverifiedTradeAmountCount,
    kisVerifiedCount,
    kisErrorCount: kisErrors.length,
    kisErrors: kisErrors.slice(0, 8),
    validation: {
      ...(sector.validation || {}),
      status: unverifiedTradeAmountCount === 0 && stockOrderErrorCount === 0 ? "ok" : "warning",
      source: KIS_ENABLED ? "KIS Open API + Naver Finance fallback" : sector.validation?.source,
      method: KIS_ENABLED
        ? "KIS REST quote overlay + Naver header-aligned fallback"
        : sector.validation?.method,
      repairedTradeAmountCount,
      derivedTradeAmountCount,
      unverifiedTradeAmountCount,
      stockOrderErrorCount,
      kisVerifiedCount,
      kisErrorCount: kisErrors.length,
      validationStatusCounts
    },
    updatedAt: new Date().toISOString()
  };
}

export async function enrichSectorWithKis(sector, options = {}) {
  const stockLimit = Number(options.stockLimit || 0);
  if (!KIS_ENABLED || !stockLimit || !Array.isArray(sector?.stocks) || !sector.stocks.length) {
    return {
      ...sector,
      kis: getKisStatus()
    };
  }

  const targetStocks = sortStocksByTradingValue(sector.stocks).slice(0, stockLimit);
  const targetCodes = new Set(targetStocks.map((stock) => stock.code).filter(Boolean));
  const quoteResults = await mapLimit(targetStocks, KIS_STOCK_CONCURRENCY, async (stock) => {
    try {
      return { code: stock.code, quote: await fetchKisQuote(stock.code, { force: options.force }) };
    } catch (error) {
      return { code: stock.code, error: error.message };
    }
  });

  const quoteMap = new Map(quoteResults.filter((item) => item.quote).map((item) => [item.code, item.quote]));
  const kisErrors = quoteResults.filter((item) => item.error);
  const stocks = sector.stocks.map((stock) => {
    if (!targetCodes.has(stock.code)) return { ...stock, dataProvider: stock.dataProvider || "Naver" };
    const quote = quoteMap.get(stock.code);
    if (!quote) {
      return {
        ...stock,
        dataProvider: stock.dataProvider || "Naver",
        kisQuote: {
          status: "error",
          error: kisErrors.find((item) => item.code === stock.code)?.error || "KIS quote unavailable",
          updatedAt: new Date().toISOString()
        }
      };
    }
    return mergeKisQuote(stock, quote);
  });

  return {
    ...recalculateSector({ ...sector, stocks }, kisErrors),
    kis: getKisStatus()
  };
}
