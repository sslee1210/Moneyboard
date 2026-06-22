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
import { fetchKisQuote, getKisStatus, KIS_ENABLED } from "./kis-provider.js";
import {
  applyRealtimeQuoteToStock,
  getRealtimeStatus,
  startKisRealtime,
  subscribeRealtimeCodes
} from "./kis-realtime.js";

const app = express();
const PORT = Number(process.env.PORT || 4173);
const STREAM_PUSH_MS = Number(process.env.STREAM_PUSH_MS || 5_000);
const MARKET_CACHE_MS = Number(process.env.MARKET_CACHE_MS || 60_000);
const OVERVIEW_CACHE_MS = Number(process.env.OVERVIEW_CACHE_MS || 5_000);
const STOCK_CODE_PATTERN = /^\d{6}$/;
const FOCUS_TOP_SECTORS = Math.max(1, Number(process.env.MONEYBOARD_FOCUS_TOP_SECTORS || 8));
const FOCUS_TOP_STOCKS = Math.max(1, Number(process.env.MONEYBOARD_FOCUS_TOP_STOCKS || 5));
const FOCUS_MAX_CODES = Math.max(1, Number(process.env.KIS_REALTIME_MAX_CODES || FOCUS_TOP_SECTORS * FOCUS_TOP_STOCKS));
const BACKFILL_ENABLED = !/^(0|false|no|off)$/i.test(String(process.env.KIS_REST_BACKFILL_ENABLED || "true"));
const BACKFILL_BATCH_SIZE = Math.max(1, Number(process.env.KIS_REST_BACKFILL_BATCH_SIZE || 1));
const BACKFILL_INTERVAL_MS = Math.max(500, Number(process.env.KIS_REST_BACKFILL_INTERVAL_MS || 2_500));
const RATE_LIMIT_COOLDOWN_MS = Math.max(1_000, Number(process.env.KIS_REST_RATE_LIMIT_COOLDOWN_MS || 8_000));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let lastRawSnapshot = null;
let lastSnapshot = null;
let lastSnapshotExpiresAt = 0;
let snapshotPromise = null;
let backfillTimer = null;
let backfillPausedUntil = 0;

const restQuotes = new Map();
const restErrors = new Map();
let focusCodes = [];
let focusCodeSet = new Set();
let pendingCodes = [];
let pendingSet = new Set();

const backfill = {
  enabled: BACKFILL_ENABLED && KIS_ENABLED,
  universeSize: 0,
  pendingSize: 0,
  successCount: 0,
  errorCount: 0,
  rateLimitCount: 0,
  requestCount: 0,
  inFlight: 0,
  lastRunAt: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: "",
  startedAt: new Date().toISOString(),
  completedOnce: false
};

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

function isRateLimitError(message) {
  return /초당|거래건수|rate|limit|too many/i.test(String(message || ""));
}

function sectorStocksForFocus(sector) {
  const source = sector?.topTradingValueStocks?.length ? sector.topTradingValueStocks : sector?.stocks || [];
  return source.filter((stock) => isValidStockCode(stock?.code));
}

function collectFocusCodes(snapshot) {
  const codes = [];
  const seen = new Set();
  for (const sector of (snapshot?.sectors || []).slice(0, FOCUS_TOP_SECTORS)) {
    let picked = 0;
    for (const stock of sectorStocksForFocus(sector)) {
      const code = String(stock.code || "");
      if (!isValidStockCode(code) || seen.has(code)) continue;
      seen.add(code);
      codes.push(code);
      picked += 1;
      if (picked >= FOCUS_TOP_STOCKS || codes.length >= FOCUS_MAX_CODES) break;
    }
    if (codes.length >= FOCUS_MAX_CODES) break;
  }
  return codes;
}

function refreshFocusUniverse(snapshot) {
  const nextCodes = collectFocusCodes(snapshot);
  focusCodes = nextCodes;
  focusCodeSet = new Set(nextCodes);
  backfill.universeSize = nextCodes.length;

  if (!backfill.enabled) return;
  for (const code of nextCodes) {
    if (restQuotes.has(code) || pendingSet.has(code)) continue;
    pendingCodes.push(code);
    pendingSet.add(code);
  }
  backfill.pendingSize = pendingCodes.length;
  if (!backfillTimer) backfillTimer = setInterval(runBackfillStep, BACKFILL_INTERVAL_MS);
  void runBackfillStep();
}

function requeueCode(code) {
  if (!isValidStockCode(code) || restQuotes.has(code) || pendingSet.has(code)) return;
  pendingCodes.push(code);
  pendingSet.add(code);
}

async function runBackfillStep() {
  if (!backfill.enabled || backfill.inFlight > 0 || pendingCodes.length === 0) return;
  if (Date.now() < backfillPausedUntil) return;

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
        const message = error?.message || String(error);
        backfill.lastError = message;
        backfill.lastErrorAt = new Date().toISOString();

        if (isRateLimitError(message)) {
          backfill.rateLimitCount += 1;
          backfillPausedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
          requeueCode(code);
          return;
        }

        restErrors.set(code, { code, error: message, at: new Date().toISOString() });
        backfill.errorCount += 1;
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
    focusTopSectors: FOCUS_TOP_SECTORS,
    focusTopStocks: FOCUS_TOP_STOCKS,
    focusCodes,
    pendingSize: pendingCodes.length,
    cachedQuoteCount: restQuotes.size,
    cachedErrorCount: restErrors.size,
    coverageRate: backfill.universeSize ? restQuotes.size / backfill.universeSize : 0,
    pausedUntil: backfillPausedUntil ? new Date(backfillPausedUntil).toISOString() : null,
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
    focusKisTarget: true,
    dataProvider: "KIS",
    tradingValueValidation: {
      ...(stock.tradingValueValidation || {}),
      status: "kis-verified",
      source: "KIS Open API REST focus backfill",
      updatedAt: quote.updatedAt
    }
  };
}

function normalizeStock(rawStock) {
  const code = String(rawStock?.code || "");
  if (!isValidStockCode(code)) return { stock: null, reason: "invalid-code" };

  const isFocus = focusCodeSet.has(code);
  const withRealtime = applyRealtimeQuoteToStock(rawStock);
  const withRest = applyRestQuote(withRealtime);
  const hasRealtime = withRest?.kisRealtimeQuote && quoteTradeAmount(withRest.kisRealtimeQuote) > 0;
  const hasRest = withRest?.kisQuote && quoteTradeAmount(withRest.kisQuote) > 0;

  if (hasRealtime || hasRest) {
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
        focusKisTarget: isFocus,
        dataProvider: hasRealtime ? "KIS-WS" : "KIS",
        tradingValueValidation: {
          ...(withRest.tradingValueValidation || {}),
          status: hasRealtime ? "kis-realtime" : "kis-verified",
          source: hasRealtime ? "KIS WebSocket focus stream" : "KIS Open API REST focus backfill",
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
      focusKisTarget: isFocus,
      dataProvider: isFocus ? "KIS focus pending" : "Naver list only",
      tradingValueValidation: {
        ...(rawStock.tradingValueValidation || {}),
        status: isFocus ? "focus-api-pending" : "not-kis-focus",
        source: isFocus
          ? "KIS focus target pending; Naver numeric fields ignored"
          : "Outside focus universe; Naver numeric fields ignored"
      }
    },
    reason: isFocus ? "pending" : "outside-focus"
  };
}

function sanitizeStocks(stocks = []) {
  const seen = new Set();
  const clean = [];
  const invalid = [];
  const duplicates = [];
  const pending = [];
  const outsideFocus = [];

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
    if (normalized.reason === "outside-focus") outsideFocus.push(normalized.stock);
    clean.push(normalized.stock);
  }

  return { stocks: sortStocksByTradingValue(clean), invalid, duplicates, pending, outsideFocus };
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
  const { stocks, invalid, duplicates, pending, outsideFocus } = sanitizeStocks(sector.stocks || []);
  const apiReadyStocks = stocks.filter((stock) => !stock.apiNumericPending);
  const focusStocks = stocks.filter((stock) => stock.focusKisTarget);
  const volumeStocks = [...apiReadyStocks].sort((left, right) => (right.volume || 0) - (left.volume || 0));
  const tradingValueMillion = apiReadyStocks.reduce((sum, stock) => sum + (stock.tradeAmountMillion || 0), 0);
  const volume = apiReadyStocks.reduce((sum, stock) => sum + (stock.volume || 0), 0);
  const validationStatusCounts = countByStatus(stocks);
  const stockOrderErrorCount = countOrderErrors(apiReadyStocks, "tradeAmountMillion");

  return {
    ...sector,
    stockCount: stocks.length,
    focusStockCount: focusStocks.length,
    apiReadyStockCount: apiReadyStocks.length,
    apiPendingCount: pending.length,
    outsideFocusCount: outsideFocus.length,
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
      outsideFocusCount: outsideFocus.length,
      focusStockCount: focusStocks.length,
      invalidStockCount: invalid.length,
      duplicateStockCount: duplicates.length,
      numericSourcePolicy: "KIS REST/WebSocket only for focus universe; Naver numeric fields ignored",
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
      acc.focusStockCount += sector.focusStockCount || 0;
      acc.apiReadyStockCount += sector.apiReadyStockCount || 0;
      acc.apiPendingCount += sector.apiPendingCount || 0;
      acc.outsideFocusCount += sector.outsideFocusCount || 0;
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
      focusStockCount: 0,
      apiReadyStockCount: 0,
      apiPendingCount: 0,
      outsideFocusCount: 0,
      invalidStockCount: 0,
      duplicateStockCount: 0,
      breadth: { rising: 0, flat: 0, falling: 0 }
    }
  );
}

function subscribeRealtimeFocusCodes() {
  void subscribeRealtimeCodes(focusCodes.slice(0, FOCUS_MAX_CODES));
}

function sanitizeSnapshot(snapshot) {
  refreshFocusUniverse(snapshot);
  subscribeRealtimeFocusCodes();

  const sectors = sortSectorsByTradingValue((snapshot.sectors || []).map(recalculateSector)).map((sector, index) => ({
    ...sector,
    rank: index + 1
  }));
  const validation = buildSnapshotValidation(sectors);
  const totals = buildTotals(sectors);
  const orderErrorCount = validation.stockOrderErrorCount || 0;

  return {
    ...snapshot,
    mode: "localhost-focus40-kis",
    provider: "KIS REST/WebSocket focus-40 numeric fields + Naver stock list",
    rankingBasis: "kis-focus40-trading-value-ready-first",
    validationMethod: "KIS REST/WebSocket numeric fields only for top 8 sectors x top 5 stocks; Naver numeric fields ignored",
    excludes: ["ETF", "ETN", "ELW", "invalid stock code rows", "Naver volume/trading-value numbers outside focus"],
    focusPolicy: { topSectors: FOCUS_TOP_SECTORS, topStocksPerSector: FOCUS_TOP_STOCKS, maxCodes: FOCUS_MAX_CODES, codes: focusCodes },
    sectors,
    totals,
    validation: {
      ...validation,
      status: orderErrorCount === 0 ? "ok" : "warning",
      errorCount: orderErrorCount,
      focusStockCount: totals.focusStockCount,
      apiReadyStockCount: totals.apiReadyStockCount,
      apiPendingCount: totals.apiPendingCount,
      outsideFocusCount: totals.outsideFocusCount,
      backfill: getBackfillStatus(),
      realtime: getRealtimeStatus(),
      numericSourcePolicy: "KIS-only numeric display for focus universe; non-focus rows keep no Naver numeric values"
    },
    backfill: getBackfillStatus(),
    realtime: getRealtimeStatus(),
    updatedAt: new Date().toISOString()
  };
}

async function buildFocusSnapshot(force = false) {
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
    mode: "localhost-focus40-kis",
    provider: "KIS REST/WebSocket focus-40 numeric fields + Naver stock list",
    overviewProvider: "Yahoo Finance",
    rankingBasis: "kis-focus40-trading-value-ready-first",
    validationMethod: "KIS REST/WebSocket numeric fields only for top 8 sectors x top 5 stocks; Naver numeric fields ignored",
    excludes: ["ETF", "ETN", "ELW", "invalid stock code rows", "Naver volume/trading-value numbers outside focus"],
    focusPolicy: { topSectors: FOCUS_TOP_SECTORS, topStocksPerSector: FOCUS_TOP_STOCKS, maxCodes: FOCUS_MAX_CODES, codes: focusCodes },
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
    provider: "KIS REST/WebSocket focus-40 numeric fields + Naver stock list",
    overviewProvider: "Yahoo Finance",
    mode: "localhost-focus40-kis",
    rankingBasis: "kis-focus40-trading-value-ready-first",
    validationMethod: "KIS REST/WebSocket numeric fields only for top 8 sectors x top 5 stocks; Naver numeric fields ignored",
    excludes: ["ETF", "ETN", "ELW", "invalid stock code rows", "Naver volume/trading-value numbers outside focus"],
    focusPolicy: { topSectors: FOCUS_TOP_SECTORS, topStocksPerSector: FOCUS_TOP_STOCKS, maxCodes: FOCUS_MAX_CODES, codes: focusCodes },
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
    response.json(await buildFocusSnapshot(request.query.force === "1"));
  } catch (error) {
    response.status(502).json({ error: error.message, realtime: getRealtimeStatus(), backfill: getBackfillStatus() });
  }
});

app.get("/api/validation", async (request, response) => {
  try {
    const snapshot = await buildFocusSnapshot(request.query.force === "1");
    response.status(snapshot.validation.status === "ok" ? 200 : 409).json(snapshot.validation);
  } catch (error) {
    response.status(502).json({ status: "error", error: error.message, realtime: getRealtimeStatus(), backfill: getBackfillStatus() });
  }
});

app.get("/api/sectors/:id", async (request, response) => {
  try {
    const snapshot = await buildFocusSnapshot(false);
    const sector = snapshot.sectors.find((item) => item.id === request.params.id);
    if (!sector) return response.status(404).json({ error: "Sector not found" });
    const detailed = await getSectorDetail(sector, {
      force: request.query.force === "1",
      kisStockLimit: 0
    });
    refreshFocusUniverse({ sectors: [detailed] });
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
      writeMarket(await buildFocusSnapshot(false));
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
  console.log(`Moneyboard focus-40 local server listening on http://localhost:${PORT}`);
  console.log("Provider: KIS REST/WebSocket focus-40 numeric fields + Naver stock list");
  console.log(`Focus policy: topSectors=${FOCUS_TOP_SECTORS}, topStocksPerSector=${FOCUS_TOP_STOCKS}, maxCodes=${FOCUS_MAX_CODES}`);
  console.log(`KIS status: ${JSON.stringify(getKisStatus())}`);
  console.log(`Realtime status: ${JSON.stringify(getRealtimeStatus())}`);
  console.log(`Backfill status: ${JSON.stringify(getBackfillStatus())}`);
  console.log(`Stream push: ${STREAM_PUSH_MS}ms, market cache: ${MARKET_CACHE_MS}ms, overview cache: ${OVERVIEW_CACHE_MS}ms.`);
});
