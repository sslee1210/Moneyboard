import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getMarketSnapshot,
  getMarketOverview,
  getSectorDetail,
  sortStocksByTradingValue,
  sortSectorsByTradingValue,
  buildSnapshotValidation
} from "./server.js";
import {
  fetchKisQuote,
  getKisStatus,
  KIS_ENABLED,
  KIS_SELECTED_SECTOR_STOCKS
} from "./kis-provider.js";
import {
  applyRealtimeQuoteToStock,
  getRealtimeStatus,
  startKisRealtime,
  subscribeRealtimeCodes
} from "./kis-realtime.js";

const app = express();
const PORT = Number(process.env.PORT || 4173);
const STREAM_PUSH_MS = Number(process.env.STREAM_PUSH_MS || 2_000);
const MARKET_CACHE_MS = Number(process.env.MARKET_CACHE_MS || 10_000);
const OVERVIEW_CACHE_MS = Number(process.env.OVERVIEW_CACHE_MS || 5_000);
const STOCK_CODE_PATTERN = /^\d{6}$/;
const REALTIME_SUBSCRIBE_TOP_SECTORS = Math.max(1, Number(process.env.KIS_REALTIME_TOP_SECTORS || 12));
const REALTIME_SUBSCRIBE_TOP_STOCKS = Math.max(1, Number(process.env.KIS_REALTIME_TOP_STOCKS || 5));
const API_ONLY_NUMERIC = /^(api-only|kis-only)$/i.test(String(process.env.KIS_NUMERIC_SOURCE || ""));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let lastSanitizedSnapshot = null;
let lastSnapshotPromise = null;

function isValidStockCode(code) {
  return STOCK_CODE_PATTERN.test(String(code || ""));
}

function isFinitePositiveNumber(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function isFiniteApiNumber(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0;
}

function apiNumericQuote(stock) {
  const realtime = stock?.kisRealtimeQuote;
  if (realtime && isFiniteApiNumber(realtime.volume) && isFiniteApiNumber(realtime.tradeAmountMillion)) {
    return { source: "KIS WebSocket", status: "kis-realtime", volume: Number(realtime.volume), tradeAmountMillion: Number(realtime.tradeAmountMillion), updatedAt: realtime.updatedAt };
  }

  const rest = stock?.kisQuote;
  if (rest && isFiniteApiNumber(rest.volume) && isFiniteApiNumber(rest.tradeAmountMillion)) {
    return { source: "KIS Open API", status: "kis-verified", volume: Number(rest.volume), tradeAmountMillion: Number(rest.tradeAmountMillion), updatedAt: rest.updatedAt };
  }

  return null;
}

function normalizeNumericSource(stock) {
  if (!API_ONLY_NUMERIC) return stock;
  const quote = apiNumericQuote(stock);
  if (!quote) {
    return {
      ...stock,
      volume: null,
      tradeAmountMillion: 0,
      apiNumericPending: true,
      dataProvider: "KIS API pending",
      tradingValueValidation: {
        ...(stock?.tradingValueValidation || {}),
        status: "api-pending",
        source: "KIS API only",
        previousStatus: stock?.tradingValueValidation?.status || "unknown"
      }
    };
  }

  return {
    ...stock,
    volume: quote.volume,
    tradeAmountMillion: quote.tradeAmountMillion,
    kisTradeAmountMillion: quote.tradeAmountMillion,
    apiNumericPending: false,
    dataProvider: quote.status === "kis-realtime" ? "KIS-WS" : "KIS",
    tradingValueValidation: {
      ...(stock?.tradingValueValidation || {}),
      status: quote.status,
      source: quote.source,
      previousStatus: stock?.tradingValueValidation?.status || "unknown",
      updatedAt: quote.updatedAt
    }
  };
}

function isVerifiedTradingValueStock(stock) {
  if (API_ONLY_NUMERIC) return true;
  const status = stock?.tradingValueValidation?.status || "unknown";
  if (status === "unverified") return false;
  if (!isFinitePositiveNumber(stock?.tradeAmountMillion)) return false;
  return true;
}

function countOrderErrors(items, field) {
  let errors = 0;
  for (let index = 1; index < items.length; index += 1) {
    if ((items[index - 1]?.[field] || 0) < (items[index]?.[field] || 0)) errors += 1;
  }
  return errors;
}

function countByValidationStatus(stocks = []) {
  return stocks.reduce((acc, stock) => {
    const status = stock.tradingValueValidation?.status || "unknown";
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
}

function sanitizeStocks(stocks = []) {
  const seen = new Set();
  const invalidStocks = [];
  const duplicateStocks = [];
  const unverifiedStocks = [];
  const cleanStocks = [];

  for (const rawStock of stocks || []) {
    const stock = normalizeNumericSource(applyRealtimeQuoteToStock(rawStock));
    const code = String(stock?.code || "");
    if (!isValidStockCode(code)) {
      invalidStocks.push(stock);
      continue;
    }
    if (seen.has(code)) {
      duplicateStocks.push(stock);
      continue;
    }
    seen.add(code);
    if (!isVerifiedTradingValueStock(stock)) {
      unverifiedStocks.push({ ...stock, code });
      continue;
    }
    cleanStocks.push({ ...stock, code });
  }

  return {
    stocks: sortStocksByTradingValue(cleanStocks),
    invalidStocks,
    duplicateStocks,
    unverifiedStocks
  };
}

function recalculateSector(sector) {
  const { stocks, invalidStocks, duplicateStocks, unverifiedStocks } = sanitizeStocks(sector.stocks || []);
  const volumeStocks = [...stocks].sort((left, right) => {
    const volumeGap = (right.volume || 0) - (left.volume || 0);
    if (volumeGap !== 0) return volumeGap;
    return (right.tradeAmountMillion || 0) - (left.tradeAmountMillion || 0);
  });

  const tradingValueMillion = stocks.reduce((sum, stock) => sum + (stock.tradeAmountMillion || 0), 0);
  const volume = stocks.reduce((sum, stock) => sum + (stock.volume || 0), 0);
  const weightedChangeRate =
    tradingValueMillion > 0
      ? stocks.reduce((sum, stock) => sum + (stock.changeRate || 0) * (stock.tradeAmountMillion || 0), 0) / tradingValueMillion
      : sector.changeRate;
  const validationStatusCounts = countByValidationStatus(stocks);
  const repairedTradeAmountCount = API_ONLY_NUMERIC
    ? 0
    : (validationStatusCounts["repaired-price-volume"] || 0) +
      (validationStatusCounts["parsed-candidate"] || 0);
  const derivedTradeAmountCount = API_ONLY_NUMERIC ? 0 : validationStatusCounts["derived-price-volume"] || 0;
  const unverifiedTradeAmountCount = API_ONLY_NUMERIC ? 0 : validationStatusCounts.unverified || 0;
  const apiPendingCount = validationStatusCounts["api-pending"] || 0;
  const kisVerifiedCount = validationStatusCounts["kis-verified"] || 0;
  const kisRealtimeCount = validationStatusCounts["kis-realtime"] || 0;
  const stockOrderErrorCount = countOrderErrors(stocks, "tradeAmountMillion");
  const invalidStockCount = invalidStocks.length;
  const duplicateStockCount = duplicateStocks.length;
  const unverifiedDroppedStockCount = API_ONLY_NUMERIC ? 0 : unverifiedStocks.length;
  const droppedStockCount = invalidStockCount + duplicateStockCount + unverifiedDroppedStockCount;

  return {
    ...sector,
    stockCount: stocks.length,
    invalidStockCount,
    duplicateStockCount,
    apiPendingCount,
    unverifiedDroppedStockCount,
    droppedStockCount,
    tradingValueMillion,
    volume,
    weightedChangeRate,
    stocks,
    topStocks: stocks.filter((stock) => !stock.apiNumericPending).slice(0, 8),
    topTradingValueStocks: stocks.filter((stock) => !stock.apiNumericPending).slice(0, 8),
    topVolumeStocks: volumeStocks.filter((stock) => !stock.apiNumericPending).slice(0, 8),
    validationStatusCounts,
    repairedTradeAmountCount,
    derivedTradeAmountCount,
    unverifiedTradeAmountCount,
    kisVerifiedCount,
    kisRealtimeCount,
    validation: {
      ...(sector.validation || {}),
      status: unverifiedTradeAmountCount === 0 && stockOrderErrorCount === 0 ? "ok" : "warning",
      stockOrderErrorCount,
      invalidStockCount,
      duplicateStockCount,
      apiPendingCount,
      unverifiedDroppedStockCount,
      droppedStockCount,
      repairedTradeAmountCount,
      derivedTradeAmountCount,
      unverifiedTradeAmountCount,
      kisVerifiedCount,
      kisRealtimeCount,
      validationStatusCounts,
      numericSourcePolicy: API_ONLY_NUMERIC ? "KIS API only" : "validated parser fallback"
    },
    realtime: getRealtimeStatus(),
    updatedAt: new Date().toISOString()
  };
}

function buildTotals(sectors = []) {
  return sectors.reduce(
    (acc, sector) => {
      acc.tradingValueMillion += sector.tradingValueMillion || 0;
      acc.volume += sector.volume || 0;
      acc.stockCount += sector.stockCount || 0;
      acc.sectorCount = sectors.length;
      acc.excludedEtfEtnCount += sector.excludedEtfEtnCount || 0;
      acc.repairedTradeAmountCount += sector.repairedTradeAmountCount || 0;
      acc.derivedTradeAmountCount += sector.derivedTradeAmountCount || 0;
      acc.unverifiedTradeAmountCount += sector.unverifiedTradeAmountCount || 0;
      acc.kisVerifiedCount += sector.kisVerifiedCount || 0;
      acc.kisRealtimeCount += sector.kisRealtimeCount || 0;
      acc.kisErrorCount += sector.kisErrorCount || 0;
      acc.invalidStockCount += sector.invalidStockCount || 0;
      acc.duplicateStockCount += sector.duplicateStockCount || 0;
      acc.apiPendingCount += sector.apiPendingCount || 0;
      acc.unverifiedDroppedStockCount += sector.unverifiedDroppedStockCount || 0;
      acc.droppedStockCount += sector.droppedStockCount || 0;
      acc.breadth.rising += sector.risingCount || 0;
      acc.breadth.flat += sector.flatCount || 0;
      acc.breadth.falling += sector.fallingCount || 0;
      return acc;
    },
    {
      tradingValueMillion: 0,
      volume: 0,
      stockCount: 0,
      sectorCount: sectors.length,
      excludedEtfEtnCount: 0,
      repairedTradeAmountCount: 0,
      derivedTradeAmountCount: 0,
      unverifiedTradeAmountCount: 0,
      kisVerifiedCount: 0,
      kisRealtimeCount: 0,
      kisErrorCount: 0,
      invalidStockCount: 0,
      duplicateStockCount: 0,
      apiPendingCount: 0,
      unverifiedDroppedStockCount: 0,
      droppedStockCount: 0,
      breadth: { rising: 0, flat: 0, falling: 0 }
    }
  );
}

function subscribeSnapshotRealtime(snapshot) {
  const codes = [];
  for (const sector of (snapshot.sectors || []).slice(0, REALTIME_SUBSCRIBE_TOP_SECTORS)) {
    for (const stock of (sector.stocks || sector.topTradingValueStocks || []).slice(0, REALTIME_SUBSCRIBE_TOP_STOCKS)) {
      if (isValidStockCode(stock.code)) codes.push(stock.code);
    }
  }
  void subscribeRealtimeCodes(codes);
}

function sanitizeSnapshot(snapshot) {
  const sectors = sortSectorsByTradingValue((snapshot.sectors || []).map(recalculateSector)).map((sector, index) => ({
    ...sector,
    rank: index + 1
  }));
  const validation = buildSnapshotValidation(sectors);
  const invalidStockCount = sectors.reduce((sum, sector) => sum + (sector.invalidStockCount || 0), 0);
  const duplicateStockCount = sectors.reduce((sum, sector) => sum + (sector.duplicateStockCount || 0), 0);
  const unverifiedDroppedStockCount = sectors.reduce((sum, sector) => sum + (sector.unverifiedDroppedStockCount || 0), 0);
  const apiPendingCount = sectors.reduce((sum, sector) => sum + (sector.apiPendingCount || 0), 0);

  const sanitized = {
    ...snapshot,
    mode: API_ONLY_NUMERIC ? "localhost-live-kis-api-only" : "localhost-live-sanitized",
    sectors,
    totals: buildTotals(sectors),
    validation: {
      ...validation,
      status: API_ONLY_NUMERIC && validation.stockOrderErrorCount === 0 ? "ok" : validation.status,
      errorCount: API_ONLY_NUMERIC ? validation.stockOrderErrorCount || 0 : validation.errorCount,
      invalidStockCount,
      duplicateStockCount,
      apiPendingCount,
      unverifiedDroppedStockCount,
      droppedStockCount: invalidStockCount + duplicateStockCount + unverifiedDroppedStockCount,
      sanitizer: API_ONLY_NUMERIC
        ? "final API response sanitizer: valid six-digit stock codes; volume/trading value shown only from KIS API fields"
        : "final API response sanitizer: valid six-digit stock codes and verified trading value only",
      numericSourcePolicy: API_ONLY_NUMERIC ? "Naver numeric volume/trading-value fields are ignored." : "validated parser fallback enabled",
      realtime: getRealtimeStatus()
    },
    realtime: getRealtimeStatus(),
    excludes: API_ONLY_NUMERIC
      ? ["ETF", "ETN", "ELW", "invalid stock code rows", "Naver volume/trading-value numbers"]
      : ["ETF", "ETN", "ELW", "invalid stock code rows", "unverified trading value rows"]
  };

  subscribeSnapshotRealtime(sanitized);
  return sanitized;
}

async function buildSanitizedMarketSnapshot(force = false) {
  if (!force && lastSanitizedSnapshot && lastSanitizedSnapshot._expiresAt > Date.now()) {
    return sanitizeSnapshot(lastSanitizedSnapshot._rawSnapshot || lastSanitizedSnapshot);
  }
  if (!force && lastSnapshotPromise) return lastSnapshotPromise;

  lastSnapshotPromise = getMarketSnapshot(force)
    .then((snapshot) => {
      const sanitized = sanitizeSnapshot(snapshot);
      lastSanitizedSnapshot = {
        ...sanitized,
        _rawSnapshot: snapshot,
        _expiresAt: Date.now() + MARKET_CACHE_MS
      };
      return sanitized;
    })
    .finally(() => {
      lastSnapshotPromise = null;
    });

  return lastSnapshotPromise;
}

function buildBootstrapSnapshot() {
  return {
    mode: API_ONLY_NUMERIC ? "localhost-live-kis-api-only" : "localhost-live-sanitized",
    provider: KIS_ENABLED ? "KIS Open API + Naver Finance" : "Naver Finance",
    overviewProvider: "Yahoo Finance",
    rankingBasis: API_ONLY_NUMERIC ? "kis-api-trading-value-only" : KIS_ENABLED ? "kis-realtime-and-validated-daily-trading-value" : "validated-daily-trading-value",
    validationMethod: API_ONLY_NUMERIC
      ? "KIS REST/WebSocket numeric fields only; Naver numeric fields ignored"
      : KIS_ENABLED
        ? "KIS WebSocket realtime overlay + KIS REST quote overlay + Naver parser fallback + final sanitizer"
        : "header-aligned parser + candidate-column validation + price-volume fallback + final sanitizer",
    excludes: API_ONLY_NUMERIC
      ? ["ETF", "ETN", "ELW", "invalid stock code rows", "Naver volume/trading-value numbers"]
      : ["ETF", "ETN", "ELW", "invalid stock code rows", "unverified trading value rows"],
    refreshMs: STREAM_PUSH_MS,
    marketCacheMs: MARKET_CACHE_MS,
    overviewCacheMs: OVERVIEW_CACHE_MS,
    updatedAt: new Date().toISOString(),
    bootstrapping: true,
    kis: getKisStatus(),
    realtime: getRealtimeStatus(),
    overview: { provider: "Yahoo Finance", items: [], updatedAt: new Date().toISOString() },
    totals: buildTotals([]),
    validation: { status: "loading", errorCount: 0, realtime: getRealtimeStatus() },
    sectors: []
  };
}

app.use(express.json({ limit: "1mb" }));

app.use((request, response, next) => {
  response.setHeader("access-control-allow-origin", request.headers.origin || "*");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
  if (request.method === "OPTIONS") return response.sendStatus(204);
  return next();
});

app.get("/api/provider", (_request, response) => {
  response.json({
    provider: API_ONLY_NUMERIC
      ? "KIS Open API/WebSocket numeric fields + Naver stock list"
      : KIS_ENABLED ? "KIS Open API + Naver Finance" : "Naver Finance",
    overviewProvider: "Yahoo Finance",
    mode: API_ONLY_NUMERIC ? "localhost-live-kis-api-only" : "localhost-live-sanitized",
    rankingBasis: API_ONLY_NUMERIC ? "kis-api-trading-value-only" : KIS_ENABLED ? "kis-realtime-and-validated-daily-trading-value" : "validated-daily-trading-value",
    validationMethod: API_ONLY_NUMERIC
      ? "KIS REST/WebSocket numeric fields only; Naver numeric fields ignored"
      : KIS_ENABLED
        ? "KIS WebSocket realtime overlay + KIS REST quote overlay + Naver header-aligned parser fallback + final response sanitizer"
        : "header-aligned parser + candidate-column validation + price-volume fallback + final response sanitizer",
    excludes: API_ONLY_NUMERIC
      ? ["ETF", "ETN", "ELW", "invalid stock code rows", "Naver volume/trading-value numbers"]
      : ["ETF", "ETN", "ELW", "invalid stock code rows", "unverified trading value rows"],
    refreshMs: STREAM_PUSH_MS,
    marketCacheMs: MARKET_CACHE_MS,
    overviewCacheMs: OVERVIEW_CACHE_MS,
    kis: getKisStatus(),
    realtime: getRealtimeStatus()
  });
});

app.get("/api/kis/status", (_request, response) => {
  response.json(getKisStatus());
});

app.get("/api/realtime/status", (_request, response) => {
  response.json(getRealtimeStatus());
});

app.get("/api/kis/quote/:code", async (request, response) => {
  try {
    response.json(await fetchKisQuote(request.params.code, { force: request.query.force === "1" }));
  } catch (error) {
    response.status(KIS_ENABLED ? 502 : 400).json({
      status: "error",
      error: error.message,
      kis: getKisStatus(),
      realtime: getRealtimeStatus()
    });
  }
});

app.get("/api/overview", async (request, response) => {
  try {
    response.json(await getMarketOverview(request.query.force === "1"));
  } catch (error) {
    response.status(502).json({ error: error.message });
  }
});

app.get("/api/sectors", async (request, response) => {
  try {
    response.json(await buildSanitizedMarketSnapshot(request.query.force === "1"));
  } catch (error) {
    response.status(502).json({ error: error.message, realtime: getRealtimeStatus() });
  }
});

app.get("/api/validation", async (request, response) => {
  try {
    const snapshot = await buildSanitizedMarketSnapshot(request.query.force === "1");
    response.status(snapshot.validation.status === "ok" ? 200 : 409).json(snapshot.validation);
  } catch (error) {
    response.status(502).json({ status: "error", error: error.message, realtime: getRealtimeStatus() });
  }
});

app.get("/api/sectors/:id", async (request, response) => {
  try {
    const snapshot = await buildSanitizedMarketSnapshot(false);
    const sector = snapshot.sectors.find((item) => item.id === request.params.id);
    if (!sector) return response.status(404).json({ error: "Sector not found" });
    response.json(
      recalculateSector(
        await getSectorDetail(sector, {
          force: request.query.force === "1",
          kisStockLimit: KIS_SELECTED_SECTOR_STOCKS
        })
      )
    );
  } catch (error) {
    response.status(502).json({ error: error.message, realtime: getRealtimeStatus() });
  }
});

app.post("/api/volume-profile", (request, response) => {
  const stocks = sortStocksByTradingValue(
    (request.body?.stocks || [])
      .map((stock) => normalizeNumericSource(applyRealtimeQuoteToStock(stock)))
      .filter((stock) => isValidStockCode(stock?.code) && isVerifiedTradingValueStock(stock) && !stock.apiNumericPending)
  );
  const limit = Number(request.body?.limit || 12);
  const items = stocks.slice(0, limit).map((stock) => ({
    code: stock.code,
    name: stock.name,
    day: stock.volume || 0,
    week: stock.periodVolumes?.week ?? null,
    month: stock.periodVolumes?.month ?? null
  }));

  response.json({
    sampleSize: items.length,
    limit,
    byCode: Object.fromEntries(items.map((item) => [item.code, item])),
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
    realtime: getRealtimeStatus(),
    updatedAt: new Date().toISOString()
  });
});

app.get("/api/stream", async (request, response) => {
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-cache, no-transform");
  response.setHeader("connection", "keep-alive");
  response.flushHeaders?.();

  let closed = false;
  let sending = false;
  request.on("close", () => {
    closed = true;
  });

  function writeMarket(snapshot) {
    if (closed) return;
    response.write("event: market\n");
    response.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  }

  const send = async () => {
    if (closed || sending) return;
    sending = true;
    try {
      const snapshot = await buildSanitizedMarketSnapshot(false);
      writeMarket(snapshot);
    } catch (error) {
      response.write("event: error\n");
      response.write(`data: ${JSON.stringify({ error: error.message, realtime: getRealtimeStatus(), updatedAt: new Date().toISOString() })}\n\n`);
    } finally {
      sending = false;
    }
  };

  writeMarket(lastSanitizedSnapshot || buildBootstrapSnapshot());
  void send();
  const interval = setInterval(send, STREAM_PUSH_MS);
  request.on("close", () => clearInterval(interval));
});

app.use(express.static(path.join(__dirname, "dist")));
app.get(/.*/, (_request, response) => {
  response.sendFile(path.join(__dirname, "dist", "index.html"));
});

startKisRealtime();

app.listen(PORT, () => {
  console.log(`Moneyboard local server listening on http://localhost:${PORT}`);
  console.log(`Provider: ${API_ONLY_NUMERIC ? "KIS numeric API only + Naver stock list" : KIS_ENABLED ? "KIS Open API + Naver Finance fallback" : "Naver Finance only. KIS is disabled."}`);
  console.log(`KIS status: ${JSON.stringify(getKisStatus())}`);
  console.log(`KIS realtime: ${JSON.stringify(getRealtimeStatus())}`);
  console.log(`Ranking basis: ${API_ONLY_NUMERIC ? "KIS API 거래대금 only. Naver 거래량/거래대금 values ignored." : "KIS realtime overlay + validated daily trading value."}`);
  console.log(`Stream push: ${STREAM_PUSH_MS}ms, market cache: ${MARKET_CACHE_MS}ms, overview cache: ${OVERVIEW_CACHE_MS}ms.`);
});
