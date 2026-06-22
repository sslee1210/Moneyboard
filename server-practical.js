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
import { fetchKisQuote, getKisStatus, KIS_ENABLED, KIS_SELECTED_SECTOR_STOCKS } from "./kis-provider.js";
import {
  applyRealtimeQuoteToStock,
  getRealtimeStatus,
  startKisRealtime,
  subscribeRealtimeCodes
} from "./kis-realtime.js";

const app = express();
const PORT = Number(process.env.PORT || 4173);
const STREAM_PUSH_MS = Number(process.env.STREAM_PUSH_MS || 2_000);
const MARKET_CACHE_MS = Number(process.env.MARKET_CACHE_MS || 30_000);
const OVERVIEW_CACHE_MS = Number(process.env.OVERVIEW_CACHE_MS || 5_000);
const STOCK_CODE_PATTERN = /^\d{6}$/;
const REALTIME_TOP_CODES = Math.max(1, Number(process.env.KIS_REALTIME_MAX_CODES || 40));
const BACKFILL_ENABLED = !/^(0|false|no|off)$/i.test(String(process.env.KIS_REST_BACKFILL_ENABLED || "true"));
const BACKFILL_MAX_CODES = Math.max(1, Number(process.env.KIS_REST_BACKFILL_MAX_CODES || 3000));
const BACKFILL_BATCH_SIZE = Math.max(1, Number(process.env.KIS_REST_BACKFILL_BATCH_SIZE || 2));
const BACKFILL_INTERVAL_MS = Math.max(100, Number(process.env.KIS_REST_BACKFILL_INTERVAL_MS || 500));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let lastRawSnapshot = null;
let lastSnapshot = null;
let lastSnapshotExpiresAt = 0;
let snapshotPromise = null;

const restQuotes = new Map();
const restErrors = new Map();
const backfill = {
  enabled: BACKFILL_ENABLED && KIS_ENABLED,
  universeSize: 0,
  pendingSize: 0,
  successCount: 0,
  errorCount: 0,
  requestCount: 0,
  inFlight: 0,
  lastRunAt: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: "",
  startedAt: new Date().toISOString(),
  completedOnce: false
};
let pendingCodes = [];
let pendingSet = new Set();
let backfillTimer = null;

function isValidStockCode(code) {
  return STOCK_CODE_PATTERN.test(String(code || ""));
}

function isNumber(value) {
  return Number.isFinite(Number(value));
}

function quoteTradeAmount(quote) {
  const amount = Number(quote?.tradeAmountMillion || 0);
  if (Number.isFinite(amount) && amount > 0) return amount;
  const derived = (Number(quote?.price || 0) * Number(quote?.volume || 0)) / 1_000_000;
  return Number.isFinite(derived) && derived > 0 ? derived : 0;
}

function allStockCodes(snapshot) {
  const codes = [];
  const seen = new Set();
  for (const sector of snapshot?.sectors || []) {
    for (const stock of sector.stocks || []) {
      const code = String(stock?.code || "");
      if (!isValidStockCode(code) || seen.has(code)) continue;
      seen.add(code);
      codes.push(code);
    }
  }
  return codes.slice(0, BACKFILL_MAX_CODES);
}

function primeBackfill(snapshot) {
  if (!backfill.enabled) return;
  const codes = allStockCodes(snapshot);
  backfill.universeSize = codes.length;
  for (const code of codes) {
    if (restQuotes.has(code) || restErrors.has(code) || pendingSet.has(code)) continue;
    pendingCodes.push(code);
    pendingSet.add(code);
  }
  backfill.pendingSize = pendingCodes.length;
  if (!backfillTimer) backfillTimer = setInterval(runBackfillStep, BACKFILL_INTERVAL_MS);
  void runBackfillStep();
}

async function runBackfillStep() {
  if (!backfill.enabled || backfill.inFlight > 0 || pendingCodes.length === 0) return;
  const batch = pendingCodes.splice(0, BACKFILL_BATCH_SIZE);
  for (const code of batch) pendingSet.delete(code);
  backfill.pendingSize = pendingCodes.length;
  backfill.inFlight = batch.length;
  backfill.lastRunAt = new Date().toISOString();

  await Promise.all(
    batch.map(async (code) => {
      try {
        backfill.requestCount += 1;
        const quote = await fetchKisQuote(code, { force: false });
        restQuotes.set(code, quote);
        restErrors.delete(code);
        backfill.successCount += 1;
        backfill.lastSuccessAt = new Date().toISOString();
      } catch (error) {
        restErrors.set(code, { code, error: error.message, at: new Date().toISOString() });
        backfill.errorCount += 1;
        backfill.lastError = error.message;
        backfill.lastErrorAt = new Date().toISOString();
      }
    })
  );

  backfill.inFlight = 0;
  backfill.pendingSize = pendingCodes.length;
  if (pendingCodes.length === 0 && backfill.universeSize > 0) backfill.completedOnce = true;
}

function getBackfillStatus() {
  const realtime = getRealtimeStatus();
  return {
    ...backfill,
    pendingSize: pendingCodes.length,
    cachedQuoteCount: restQuotes.size,
    cachedErrorCount: restErrors.size,
    coverageRate: backfill.universeSize ? restQuotes.size / backfill.universeSize : 0,
    realtimeMaxCodes: realtime.maxCodes,
    realtimeSubscribedCount: realtime.subscribedCount,
    realtimeQuoteCount: realtime.quoteCount
  };
}

function applyRestQuote(stock) {
  const quote = restQuotes.get(String(stock?.code || ""));
  if (!quote) return stock;
  const tradeAmountMillion = quoteTradeAmount(quote);
  return {
    ...stock,
    name: stock.name || quote.name,
    price: quote.price || stock.price,
    changeAmount: isNumber(quote.changeAmount) ? quote.changeAmount : stock.changeAmount,
    changeRate: isNumber(quote.changeRate) ? quote.changeRate : stock.changeRate,
    volume: quote.volume,
    tradeAmountMillion,
    kisTradeAmountMillion: tradeAmountMillion,
    kisQuote: quote,
    apiNumericPending: false,
    dataProvider: "KIS",
    tradingValueValidation: {
      ...(stock.tradingValueValidation || {}),
      status: "kis-verified",
      source: "KIS Open API REST backfill",
      updatedAt: quote.updatedAt
    }
  };
}

function normalizeStock(rawStock) {
  const code = String(rawStock?.code || "");
  if (!isValidStockCode(code)) return { stock: null, reason: "invalid-code" };

  const withRealtime = applyRealtimeQuoteToStock(rawStock);
  const withRest = applyRestQuote(withRealtime);
  const hasRealtime = withRest?.kisRealtimeQuote && quoteTradeAmount(withRest.kisRealtimeQuote) > 0;
  const hasRest = withRest?.kisQuote && quoteTradeAmount(withRest.kisQuote) > 0;

  if (hasRealtime || hasRest) {
    const source = hasRealtime ? "KIS WebSocket" : "KIS Open API REST backfill";
    const status = hasRealtime ? "kis-realtime" : "kis-verified";
    const quote = hasRealtime ? withRest.kisRealtimeQuote : withRest.kisQuote;
    const tradeAmountMillion = quoteTradeAmount(quote);
    return {
      stock: {
        ...withRest,
        code,
        volume: Number(quote.volume || 0),
        tradeAmountMillion,
        kisTradeAmountMillion: tradeAmountMillion,
        apiNumericPending: false,
        dataProvider: hasRealtime ? "KIS-WS" : "KIS",
        tradingValueValidation: {
          ...(withRest.tradingValueValidation || {}),
          status,
          source,
          updatedAt: quote.updatedAt
        }
      },
      reason: "ok"
    };
  }

  return {
    stock: {
      ...rawStock,
      code,
      volume: null,
      tradeAmountMillion: 0,
      kisTradeAmountMillion: 0,
      apiNumericPending: true,
      dataProvider: "KIS API pending",
      tradingValueValidation: {
        ...(rawStock.tradingValueValidation || {}),
        status: "api-pending",
        source: "KIS API only; Naver numeric fields ignored"
      }
    },
    reason: "pending"
  };
}

function sanitizeStocks(stocks = []) {
  const seen = new Set();
  const clean = [];
  const invalid = [];
  const duplicates = [];
  const pending = [];

  for (const raw of stocks) {
    const normalized = normalizeStock(raw);
    if (!normalized.stock) {
      invalid.push(raw);
      continue;
    }
    if (seen.has(normalized.stock.code)) {
      duplicates.push(normalized.stock);
      continue;
    }
    seen.add(normalized.stock.code);
    if (normalized.reason === "pending") pending.push(normalized.stock);
    clean.push(normalized.stock);
  }

  return { stocks: sortStocksByTradingValue(clean), invalid, duplicates, pending };
}

function countByStatus(stocks = []) {
  return stocks.reduce((acc, stock) => {
    const status = stock?.tradingValueValidation?.status || "unknown";
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
}

function countOrderErrors(items, field) {
  let errors = 0;
  for (let index = 1; index < items.length; index += 1) {
    if ((items[index - 1]?.[field] || 0) < (items[index]?.[field] || 0)) errors += 1;
  }
  return errors;
}

function recalculateSector(sector) {
  const { stocks, invalid, duplicates, pending } = sanitizeStocks(sector.stocks || []);
  const apiReadyStocks = stocks.filter((stock) => !stock.apiNumericPending);
  const volumeStocks = [...apiReadyStocks].sort((left, right) => (right.volume || 0) - (left.volume || 0));
  const tradingValueMillion = apiReadyStocks.reduce((sum, stock) => sum + (stock.tradeAmountMillion || 0), 0);
  const volume = apiReadyStocks.reduce((sum, stock) => sum + (stock.volume || 0), 0);
  const validationStatusCounts = countByStatus(stocks);
  const stockOrderErrorCount = countOrderErrors(apiReadyStocks, "tradeAmountMillion");

  return {
    ...sector,
    stockCount: stocks.length,
    apiReadyStockCount: apiReadyStocks.length,
    apiPendingCount: pending.length,
    invalidStockCount: invalid.length,
    duplicateStockCount: duplicates.length,
    droppedStockCount: invalid.length + duplicates.length,
    tradingValueMillion,
    volume,
    weightedChangeRate:
      tradingValueMillion > 0
        ? apiReadyStocks.reduce((sum, stock) => sum + (stock.changeRate || 0) * (stock.tradeAmountMillion || 0), 0) / tradingValueMillion
        : sector.changeRate,
    stocks,
    topStocks: apiReadyStocks.slice(0, 8),
    topTradingValueStocks: apiReadyStocks.slice(0, 8),
    topVolumeStocks: volumeStocks.slice(0, 8),
    validationStatusCounts,
    kisVerifiedCount: validationStatusCounts["kis-verified"] || 0,
    kisRealtimeCount: validationStatusCounts["kis-realtime"] || 0,
    validation: {
      ...(sector.validation || {}),
      status: stockOrderErrorCount === 0 ? "ok" : "warning",
      stockOrderErrorCount,
      apiPendingCount: pending.length,
      apiReadyStockCount: apiReadyStocks.length,
      invalidStockCount: invalid.length,
      duplicateStockCount: duplicates.length,
      numericSourcePolicy: "KIS REST/WebSocket only; Naver numeric fields ignored",
      validationStatusCounts
    },
    realtime: getRealtimeStatus(),
    backfill: getBackfillStatus(),
    updatedAt: new Date().toISOString()
  };
}

function buildTotals(sectors = []) {
  return sectors.reduce(
    (acc, sector) => {
      acc.tradingValueMillion += sector.tradingValueMillion || 0;
      acc.volume += sector.volume || 0;
      acc.stockCount += sector.stockCount || 0;
      acc.apiReadyStockCount += sector.apiReadyStockCount || 0;
      acc.apiPendingCount += sector.apiPendingCount || 0;
      acc.invalidStockCount += sector.invalidStockCount || 0;
      acc.duplicateStockCount += sector.duplicateStockCount || 0;
      acc.breadth.rising += sector.risingCount || 0;
      acc.breadth.flat += sector.flatCount || 0;
      acc.breadth.falling += sector.fallingCount || 0;
      return acc;
    },
    {
      tradingValueMillion: 0,
      volume: 0,
      stockCount: 0,
      apiReadyStockCount: 0,
      apiPendingCount: 0,
      invalidStockCount: 0,
      duplicateStockCount: 0,
      breadth: { rising: 0, flat: 0, falling: 0 }
    }
  );
}

function subscribeRealtimeTopCodes(snapshot) {
  const codes = [];
  const seen = new Set();
  for (const sector of snapshot?.sectors || []) {
    for (const stock of sector.stocks || sector.topTradingValueStocks || []) {
      if (!isValidStockCode(stock?.code) || seen.has(stock.code)) continue;
      seen.add(stock.code);
      codes.push(stock.code);
      if (codes.length >= REALTIME_TOP_CODES) break;
    }
    if (codes.length >= REALTIME_TOP_CODES) break;
  }
  void subscribeRealtimeCodes(codes);
}

function sanitizeSnapshot(snapshot) {
  primeBackfill(snapshot);
  subscribeRealtimeTopCodes(snapshot);

  const sectors = sortSectorsByTradingValue((snapshot.sectors || []).map(recalculateSector)).map((sector, index) => ({
    ...sector,
    rank: index + 1
  }));
  const validation = buildSnapshotValidation(sectors);
  const totals = buildTotals(sectors);
  const orderErrorCount = validation.stockOrderErrorCount || 0;

  return {
    ...snapshot,
    mode: "localhost-practical-kis-backfill",
    provider: "KIS REST/WebSocket numeric fields + Naver stock list",
    rankingBasis: "kis-api-trading-value-ready-first",
    validationMethod: "KIS REST/WebSocket numeric fields only; Naver numeric fields ignored for displayed volume/trading value",
    excludes: ["ETF", "ETN", "ELW", "invalid stock code rows", "Naver volume/trading-value numbers"],
    sectors,
    totals,
    validation: {
      ...validation,
      status: orderErrorCount === 0 ? "ok" : "warning",
      errorCount: orderErrorCount,
      apiReadyStockCount: totals.apiReadyStockCount,
      apiPendingCount: totals.apiPendingCount,
      backfill: getBackfillStatus(),
      realtime: getRealtimeStatus(),
      numericSourcePolicy: "KIS-only numeric display; pending rows are kept but ranked below API-ready rows"
    },
    backfill: getBackfillStatus(),
    realtime: getRealtimeStatus(),
    updatedAt: new Date().toISOString()
  };
}

async function buildPracticalSnapshot(force = false) {
  if (!force && lastRawSnapshot && lastSnapshotExpiresAt > Date.now()) {
    lastSnapshot = sanitizeSnapshot(lastRawSnapshot);
    return lastSnapshot;
  }
  if (!force && snapshotPromise) return snapshotPromise;

  snapshotPromise = getMarketSnapshot(force)
    .then((snapshot) => {
      lastRawSnapshot = snapshot;
      lastSnapshotExpiresAt = Date.now() + MARKET_CACHE_MS;
      lastSnapshot = sanitizeSnapshot(snapshot);
      return lastSnapshot;
    })
    .finally(() => {
      snapshotPromise = null;
    });
  return snapshotPromise;
}

function bootstrapSnapshot() {
  return {
    mode: "localhost-practical-kis-backfill",
    provider: "KIS REST/WebSocket numeric fields + Naver stock list",
    overviewProvider: "Yahoo Finance",
    rankingBasis: "kis-api-trading-value-ready-first",
    validationMethod: "KIS REST/WebSocket numeric fields only; Naver numeric fields ignored for displayed volume/trading value",
    excludes: ["ETF", "ETN", "ELW", "invalid stock code rows", "Naver volume/trading-value numbers"],
    refreshMs: STREAM_PUSH_MS,
    marketCacheMs: MARKET_CACHE_MS,
    overviewCacheMs: OVERVIEW_CACHE_MS,
    bootstrapping: true,
    kis: getKisStatus(),
    realtime: getRealtimeStatus(),
    backfill: getBackfillStatus(),
    overview: { provider: "Yahoo Finance", items: [], updatedAt: new Date().toISOString() },
    totals: buildTotals([]),
    validation: { status: "loading", errorCount: 0, backfill: getBackfillStatus(), realtime: getRealtimeStatus() },
    sectors: [],
    updatedAt: new Date().toISOString()
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
    provider: "KIS REST/WebSocket numeric fields + Naver stock list",
    overviewProvider: "Yahoo Finance",
    mode: "localhost-practical-kis-backfill",
    rankingBasis: "kis-api-trading-value-ready-first",
    validationMethod: "KIS REST/WebSocket numeric fields only; Naver numeric fields ignored",
    excludes: ["ETF", "ETN", "ELW", "invalid stock code rows", "Naver volume/trading-value numbers"],
    refreshMs: STREAM_PUSH_MS,
    marketCacheMs: MARKET_CACHE_MS,
    overviewCacheMs: OVERVIEW_CACHE_MS,
    kis: getKisStatus(),
    realtime: getRealtimeStatus(),
    backfill: getBackfillStatus()
  });
});

app.get("/api/kis/status", (_request, response) => response.json(getKisStatus()));
app.get("/api/realtime/status", (_request, response) => response.json(getRealtimeStatus()));
app.get("/api/backfill/status", (_request, response) => response.json(getBackfillStatus()));

app.get("/api/kis/quote/:code", async (request, response) => {
  try {
    const quote = await fetchKisQuote(request.params.code, { force: request.query.force === "1" });
    restQuotes.set(quote.code, quote);
    response.json(quote);
  } catch (error) {
    response.status(KIS_ENABLED ? 502 : 400).json({ status: "error", error: error.message, kis: getKisStatus() });
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
    response.json(await buildPracticalSnapshot(request.query.force === "1"));
  } catch (error) {
    response.status(502).json({ error: error.message, realtime: getRealtimeStatus(), backfill: getBackfillStatus() });
  }
});

app.get("/api/validation", async (request, response) => {
  try {
    const snapshot = await buildPracticalSnapshot(request.query.force === "1");
    response.status(snapshot.validation.status === "ok" ? 200 : 409).json(snapshot.validation);
  } catch (error) {
    response.status(502).json({ status: "error", error: error.message, realtime: getRealtimeStatus(), backfill: getBackfillStatus() });
  }
});

app.get("/api/sectors/:id", async (request, response) => {
  try {
    const snapshot = await buildPracticalSnapshot(false);
    const sector = snapshot.sectors.find((item) => item.id === request.params.id);
    if (!sector) return response.status(404).json({ error: "Sector not found" });
    const detailed = await getSectorDetail(sector, {
      force: request.query.force === "1",
      kisStockLimit: 0
    });
    primeBackfill({ sectors: [detailed] });
    response.json(recalculateSector(detailed));
  } catch (error) {
    response.status(502).json({ error: error.message, realtime: getRealtimeStatus(), backfill: getBackfillStatus() });
  }
});

app.post("/api/volume-profile", (request, response) => {
  const stocks = sortStocksByTradingValue(
    (request.body?.stocks || [])
      .map((stock) => normalizeStock(stock).stock)
      .filter((stock) => stock && !stock.apiNumericPending)
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
    backfill: getBackfillStatus(),
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

  const writeMarket = (snapshot) => {
    if (closed) return;
    response.write("event: market\n");
    response.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  };

  const send = async () => {
    if (closed || sending) return;
    sending = true;
    try {
      writeMarket(await buildPracticalSnapshot(false));
    } catch (error) {
      response.write("event: error\n");
      response.write(`data: ${JSON.stringify({ error: error.message, realtime: getRealtimeStatus(), backfill: getBackfillStatus(), updatedAt: new Date().toISOString() })}\n\n`);
    } finally {
      sending = false;
    }
  };

  writeMarket(lastSnapshot || bootstrapSnapshot());
  void send();
  const interval = setInterval(send, STREAM_PUSH_MS);
  request.on("close", () => clearInterval(interval));
});

app.use(express.static(path.join(__dirname, "dist")));
app.get(/.*/, (_request, response) => response.sendFile(path.join(__dirname, "dist", "index.html")));

startKisRealtime();

app.listen(PORT, () => {
  console.log(`Moneyboard practical local server listening on http://localhost:${PORT}`);
  console.log("Provider: KIS REST/WebSocket numeric fields + Naver stock list");
  console.log(`KIS status: ${JSON.stringify(getKisStatus())}`);
  console.log(`Realtime status: ${JSON.stringify(getRealtimeStatus())}`);
  console.log(`Backfill status: ${JSON.stringify(getBackfillStatus())}`);
  console.log(`Stream push: ${STREAM_PUSH_MS}ms, market cache: ${MARKET_CACHE_MS}ms, overview cache: ${OVERVIEW_CACHE_MS}ms.`);
});
