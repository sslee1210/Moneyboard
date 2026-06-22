const KIS_PROD_BASE_URL = "https://openapi.koreainvestment.com:9443";
const KIS_MOCK_BASE_URL = "https://openapivts.koreainvestment.com:29443";
const TOKEN_SAFETY_MS = 60_000;
const REQUEST_TIMEOUT_MS = Number(process.env.KIS_REQUEST_TIMEOUT_MS || 10_000);
const QUOTE_CONCURRENCY = Number(process.env.KIS_QUOTE_CONCURRENCY || 4);
const HISTORY_CONCURRENCY = Number(process.env.KIS_HISTORY_CONCURRENCY || 2);
const DEFAULT_HISTORY_LIMIT = Number(process.env.KIS_VOLUME_HISTORY_LIMIT || 12);

const tokenState = {
  accessToken: "",
  expiresAt: 0,
  promise: null
};

function kisBaseUrl() {
  if (process.env.KIS_BASE_URL) return process.env.KIS_BASE_URL.replace(/\/$/, "");
  return process.env.KIS_MOCK === "true" ? KIS_MOCK_BASE_URL : KIS_PROD_BASE_URL;
}

function appKey() {
  return process.env.KIS_APP_KEY || "";
}

function appSecret() {
  return process.env.KIS_APP_SECRET || "";
}

function isKisConfigured() {
  return Boolean(appKey() && appSecret());
}

function getKisStatus() {
  return {
    configured: isKisConfigured(),
    baseUrl: kisBaseUrl(),
    mock: process.env.KIS_MOCK === "true",
    tokenReady: Boolean(tokenState.accessToken && tokenState.expiresAt > Date.now())
  };
}

function parseNumber(value) {
  const normalized = String(value ?? "").replace(/,/g, "").trim();
  if (!normalized || normalized === "-") return 0;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function formatDateParam(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function getAccessToken() {
  if (!isKisConfigured()) {
    throw new Error("KIS_APP_KEY and KIS_APP_SECRET are required");
  }

  if (tokenState.accessToken && tokenState.expiresAt > Date.now() + TOKEN_SAFETY_MS) {
    return tokenState.accessToken;
  }

  if (tokenState.promise) return tokenState.promise;

  tokenState.promise = fetchWithTimeout(`${kisBaseUrl()}/oauth2/tokenP`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      grant_type: "client_credentials",
      appkey: appKey(),
      appsecret: appSecret()
    })
  })
    .then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.access_token) {
        throw new Error(data.msg1 || data.message || `KIS token HTTP ${response.status}`);
      }

      tokenState.accessToken = data.access_token;
      tokenState.expiresAt = Date.now() + Math.max(0, Number(data.expires_in || 86_400) * 1000 - TOKEN_SAFETY_MS);
      tokenState.promise = null;
      return tokenState.accessToken;
    })
    .catch((error) => {
      tokenState.promise = null;
      throw error;
    });

  return tokenState.promise;
}

async function requestKis(pathname, query, trId) {
  const token = await getAccessToken();
  const url = new URL(pathname, kisBaseUrl());

  Object.entries(query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  });

  const response = await fetchWithTimeout(url, {
    headers: {
      authorization: `Bearer ${token}`,
      appkey: appKey(),
      appsecret: appSecret(),
      tr_id: trId,
      custtype: "P",
      "content-type": "application/json"
    }
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || (data.rt_cd && data.rt_cd !== "0")) {
    throw new Error(data.msg1 || data.message || `KIS ${trId} HTTP ${response.status}`);
  }

  return data;
}

async function getKisQuote(code) {
  const data = await requestKis(
    "/uapi/domestic-stock/v1/quotations/inquire-price",
    {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_INPUT_ISCD: code
    },
    "FHKST01010100"
  );
  const output = data.output || {};
  const tradingValueWon = parseNumber(output.acml_tr_pbmn);

  return {
    code,
    price: parseNumber(output.stck_prpr),
    changeAmount: parseNumber(output.prdy_vrss),
    changeRate: parseNumber(output.prdy_ctrt),
    bid: parseNumber(output.bidp),
    ask: parseNumber(output.askp),
    volume: parseNumber(output.acml_vol),
    tradeAmountMillion: tradingValueWon ? tradingValueWon / 1_000_000 : 0,
    source: "KIS",
    fetchedAt: new Date().toISOString()
  };
}

async function getKisDailyRows(code) {
  const endDate = new Date();
  const startDate = addDays(endDate, -70);
  const data = await requestKis(
    "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
    {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_INPUT_ISCD: code,
      FID_INPUT_DATE_1: formatDateParam(startDate),
      FID_INPUT_DATE_2: formatDateParam(endDate),
      FID_PERIOD_DIV_CODE: "D",
      FID_ORG_ADJ_PRC: "0"
    },
    "FHKST03010100"
  );

  return (data.output2 || [])
    .map((row) => ({
      date: row.stck_bsop_date,
      close: parseNumber(row.stck_clpr),
      volume: parseNumber(row.acml_vol)
    }))
    .filter((row) => row.date)
    .sort((left, right) => left.date.localeCompare(right.date));
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function enrichStocksWithKis(stocks, { limit = 20 } = {}) {
  if (!isKisConfigured()) return stocks;

  const sample = (stocks || []).slice(0, limit);
  const updates = await mapLimit(sample, QUOTE_CONCURRENCY, async (stock) => {
    try {
      return await getKisQuote(stock.code);
    } catch (error) {
      return {
        code: stock.code,
        error: error.message
      };
    }
  });
  const byCode = new Map(updates.map((quote) => [quote.code, quote]));

  return stocks.map((stock) => {
    const quote = byCode.get(stock.code);
    if (!quote || quote.error) return stock;
    const changeRate = quote.changeRate || stock.changeRate || 0;

    return {
      ...stock,
      price: quote.price || stock.price,
      changeAmount: quote.changeAmount,
      changeRate,
      bid: quote.bid || stock.bid,
      ask: quote.ask || stock.ask,
      volume: quote.volume || stock.volume,
      tradeAmountMillion: quote.tradeAmountMillion || stock.tradeAmountMillion,
      direction: changeRate > 0 ? "up" : changeRate < 0 ? "down" : "flat",
      provider: "KIS",
      providerFetchedAt: quote.fetchedAt
    };
  });
}

async function getKisVolumeProfile(stocks, { limit = DEFAULT_HISTORY_LIMIT } = {}) {
  if (!isKisConfigured()) {
    throw new Error("KIS is not configured");
  }

  const sample = (stocks || []).slice(0, limit);
  const items = await mapLimit(sample, HISTORY_CONCURRENCY, async (stock) => {
    try {
      const rows = await getKisDailyRows(stock.code);
      const latest = rows.at(-1);
      const sumRecentVolume = (count) => rows.slice(-count).reduce((sum, row) => sum + row.volume, 0);

      return {
        code: stock.code,
        name: stock.name,
        day: stock.volume || latest?.volume || 0,
        week: rows.length ? sumRecentVolume(5) : null,
        month: rows.length ? sumRecentVolume(20) : null,
        weekDate: latest?.date || null,
        monthDate: latest?.date || null,
        provider: "KIS"
      };
    } catch (error) {
      return {
        code: stock.code,
        name: stock.name,
        day: stock.volume || 0,
        week: null,
        month: null,
        error: error.message,
        provider: "KIS"
      };
    }
  });
  const byCode = Object.fromEntries(items.map((item) => [item.code, item]));

  return {
    sampleSize: sample.length,
    limit,
    byCode,
    counts: {
      day: items.filter((item) => item.day !== null && item.day !== undefined).length,
      week: items.filter((item) => item.week !== null && item.week !== undefined).length,
      month: items.filter((item) => item.month !== null && item.month !== undefined).length
    },
    totals: {
      day: items.reduce((sum, item) => sum + (item.day || 0), 0),
      week: items.reduce((sum, item) => sum + (item.week || 0), 0),
      month: items.reduce((sum, item) => sum + (item.month || 0), 0)
    },
    updatedAt: new Date().toISOString(),
    provider: "KIS"
  };
}

export { enrichStocksWithKis, getKisQuote, getKisStatus, getKisVolumeProfile, isKisConfigured };
