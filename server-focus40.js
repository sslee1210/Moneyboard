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
const STREAM_PUSH_MS = Number(process.env.STREAM_PUSH_MS || 3_000);
const MARKET_CACHE_MS = Number(process.env.MARKET_CACHE_MS || 15_000);
const OVERVIEW_CACHE_MS = Number(process.env.OVERVIEW_CACHE_MS || 5_000);
const STOCK_CODE_PATTERN = /^\d{6}$/;
const FOCUS_SECTOR_COUNT = Math.max(1, Number(process.env.KIS_FOCUS_SECTORS || 8));
const FOCUS_STOCKS_PER_SECTOR = Math.max(1, Number(process.env.KIS_FOCUS_STOCKS_PER_SECTOR || 5));
const FOCUS_MAX_CODES = Math.max(1, Number(process.env.KIS_FOCUS_MAX_CODES || 40));
const BACKFILL_INTERVAL_MS = Math.max(1_000, Number(process.env.KIS_FOCUS_BACKFILL_INTERVAL_MS || 2_000));
const RATE_LIMIT_COOLDOWN_MS = Math.max(5_000, Number(process.env.KIS_RATE_LIMIT_COOLDOWN_MS || 15_000));
const FLOW_KEEP_MINUTES = Math.max(2, Number(process.env.MINUTE_FLOW_KEEP || 8));
const FLOW_LEVELS = [
  { thresholdMillion: 5_000, label: "50억/min", icon: "⚡", severity: "ultra" },
  { thresholdMillion: 3_000, label: "30억/min", icon: "🚀", severity: "strong" },
  { thresholdMillion: 1_000, label: "10억/min", icon: "🔥", severity: "watch" }
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let lastRawSnapshot = null;
let lastSnapshot = null;
let lastSnapshotExpiresAt = 0;
let snapshotPromise = null;
let lastFocusCodes = [];
let lastFocusUpdatedAt = null;
let backfillTimer = null;
let backfillKickTimer = null;
let cooldownUntil = 0;

const restQuotes = new Map();
const restErrors = new Map();
const pendingSet = new Set();
let pendingCodes = [];
const minuteFlowByCode = new Map();

const backfill = {
  enabled: KIS_ENABLED,
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

function flowLevel(amountMillion) {
  return FLOW_LEVELS.find((level) => amountMillion >= level.thresholdMillion) || null;
}

function minuteKey(at = new Date()) {
  const date = at instanceof Date ? at : new Date(at);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return { key: `${y}${m}${d}-${h}${min}`, label: `${h}:${min}` };
}

function recordMinuteFlow(code, cumulativeTradeAmountMillion, updatedAt) {
  const cumulative = Number(cumulativeTradeAmountMillion || 0);
  if (!isValidStockCode(code) || !Number.isFinite(cumulative) || cumulative <= 0) return null;

  const now = updatedAt ? new Date(updatedAt) : new Date();
  const clock = minuteKey(now);
  let state = minuteFlowByCode.get(code);
  if (!state) {
    state = { lastCumulative: cumulative, bars: [] };
    minuteFlowByCode.set(code, state);
  }

  let delta = cumulative - Number(state.lastCumulative || 0);
  if (!Number.isFinite(delta) || delta < 0 || delta > 200_000) delta = 0;
  state.lastCumulative = cumulative;

  let bar = state.bars[state.bars.length - 1];
  if (!bar || bar.key !== clock.key) {
    bar = { key: clock.key, minute: clock.label, amountMillion: 0, updatedAt: now.toISOString() };
    state.bars.push(bar);
    if (state.bars.length > FLOW_KEEP_MINUTES) state.bars = state.bars.slice(-FLOW_KEEP_MINUTES);
  }

  if (delta > 0) bar.amountMillion += delta;
  bar.updatedAt = now.toISOString();

  const level = flowLevel(bar.amountMillion);
  return {
    ...bar,
    amountMillion: Number(bar.amountMillion.toFixed(3)),
    amountWon: Math.round(bar.amountMillion * 1_000_000),
    label: level ? `${level.icon} ${level.label}` : "",
    severity: level?.severity || "normal",
    alert: Boolean(level),
    thresholdMillion: level?.thresholdMillion || 1_000
  };
}

function isRateLimitError(error) {
  const message = String(error?.message || "");
  return /초당|거래건수|rate|limit|too many/i.test(message);
}

function sameCodeList(left = [], right = []) {
  if (left.length !== right.length) return false;
  return left.every((code, index) => code === right[index]);
}

function focusCodesFromSnapshot(snapshot) {
  const codes = [];
  const seen = new Set();
  const sectors = sortSectorsByTradingValue(snapshot?.sectors || []).slice(0, FOCUS_SECTOR_COUNT);
  for (const sector of sectors) {
    const stocks = sortStocksByTradingValue(sector.stocks || [])
      .filter((stock) => isValidStockCode(stock?.code))
      .slice(0, FOCUS_STOCKS_PER_SECTOR);
    for (const stock of stocks) {
      const code = String(stock.code);
      if (seen.has(code)) continue;
      seen.add(code);
      codes.push(code);
      if (codes.length >= FOCUS_MAX_CODES) return codes;
    }
  }
  return codes;
}

function scheduleBackfillKick() {
  if (backfillKickTimer || backfill.inFlight > 0 || Date.now() < cooldownUntil) return;
  backfillKickTimer = setTimeout(() => {
    backfillKickTimer = null;
    void runBackfillStep();
  }, 250);
}

function enqueueFocusCodes(codes) {
  let added = 0;
  for (const code of codes) {
    if (restQuotes.has(code) || restErrors.has(code) || pendingSet.has(code)) continue;
    pendingCodes.push(code);
    pendingSet.add(code);
    added += 1;
  }
  backfill.universeSize = codes.length;
  backfill.pendingSize = pendingCodes.length;
  if (added > 0) backfill.completedOnce = false;
  if (!backfillTimer) backfillTimer = setInterval(runBackfillStep, BACKFILL_INTERVAL_MS);
  if (added > 0) scheduleBackfillKick();
}

function primeFocus(snapshot) {
  const codes = focusCodesFromSnapshot(snapshot);
  const changed = !sameCodeList(codes, lastFocusCodes);
  if (changed) {
    lastFocusCodes = codes;
    lastFocusUpdatedAt = new Date().toISOString();
    void subscribeRealtimeCodes(codes);
  }
  enqueueFocusCodes(codes);
}

async function runBackfillStep() {
  if (!backfill.enabled || backfill.inFlight > 0 || pendingCodes.length === 0) return;
  if (Date.now() < cooldownUntil) return;

  const code = pendingCodes.shift();
  pendingSet.delete(code);
  backfill.pendingSize = pendingCodes.length;
  backfill.inFlight = 1;
  backfill.lastRunAt = new Date().toISOString();

  try {
    backfill.requestCount += 1;
    const quote = await fetchKisQuote(code, { force: false });
    restQuotes.set(code, quote);
    restErrors.delete(code);
    backfill.successCount += 1;
    backfill.lastSuccessAt = new Date().toISOString();
  } catch (error) {
    backfill.lastError = error.message;
    backfill.lastErrorAt = new Date().toISOString();
    if (isRateLimitError(error)) {
      backfill.rateLimitCount += 1;
      cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
      if (!pendingSet.has(code) && !restQuotes.has(code)) {
        pendingCodes.push(code);
        pendingSet.add(code);
      }
    } else {
      restErrors.set(code, { code, error: error.message, at: new Date().toISOString() });
      backfill.errorCount += 1;
    }
  } finally {
    backfill.inFlight = 0;
    backfill.pendingSize = pendingCodes.length;
    if (pendingCodes.length === 0 && backfill.universeSize > 0) backfill.completedOnce = true;
  }
}

function getBackfillStatus() {
  const realtime = getRealtimeStatus();
  const minuteFlowAlerts = [...minuteFlowByCode.values()].filter((state) => state.bars?.some((bar) => flowLevel(bar.amountMillion))).length;
  return {
    ...backfill,
    pendingSize: pendingCodes.length,
    focusSectors: FOCUS_SECTOR_COUNT,
    focusStocksPerSector: FOCUS_STOCKS_PER_SECTOR,
    focusMaxCodes: FOCUS_MAX_CODES,
    focusCodes: lastFocusCodes,
    focusCodeCount: lastFocusCodes.length,
    focusUpdatedAt: lastFocusUpdatedAt,
    cachedQuoteCount: restQuotes.size,
    cachedErrorCount: restErrors.size,
    coverageRate: backfill.universeSize ? restQuotes.size / backfill.universeSize : 0,
    cooldownMsRemaining: Math.max(0, cooldownUntil - Date.now()),
    realtimeMaxCodes: realtime.maxCodes,
    realtimeSubscribedCount: realtime.subscribedCount,
    realtimeQuoteCount: realtime.quoteCount,
    minuteFlowAlerts
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
      source: "KIS REST focus-40",
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
    const quote = hasRealtime ? withRest.kisRealtimeQuote : withRest.kisQuote;
    const tradeAmountMillion = quoteTradeAmount(quote);
    const minuteFlow = recordMinuteFlow(code, tradeAmountMillion, quote.updatedAt || withRest.updatedAt);
    return {
      stock: {
        ...withRest,
        code,
        volume: Number(quote.volume || 0),
        tradeAmountMillion,
        kisTradeAmountMillion: tradeAmountMillion,
        minuteFlow,
        minuteTradeAmountMillion: minuteFlow?.amountMillion || 0,
        minuteTradeAmountLabel: minuteFlow?.label || "",
        minuteFlowAlert: Boolean(minuteFlow?.alert),
        apiNumericPending: false,
        dataProvider: hasRealtime ? (minuteFlow?.alert ? `KIS-WS ${minuteFlow.label}` : "KIS-WS") : "KIS",
        tradingValueValidation: {
          ...(withRest.tradingValueValidation || {}),
          status: hasRealtime ? "kis-realtime" : "kis-verified",
          source: hasRealtime ? `KIS WebSocket focus-40${minuteFlow?.alert ? ` · ${minuteFlow.label}` : ""}` : "KIS REST focus-40",
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
      minuteFlow: null,
      minuteTradeAmountMillion: 0,
      minuteTradeAmountLabel: "",
      minuteFlowAlert: false,
      apiNumericPending: true,
      dataProvider: "API pending",
      tradingValueValidation: {
        ...(rawStock.tradingValueValidation || {}),
        status: "api-pending",
        source: "Realtime numeric provider pending; Naver numeric fields ignored"
      }
    },
    reason: "pending"
  };
}

function sanitizeStocks(stocks = []) {
  const seen = new Set();
  const clean = [];
  const invalid = [];
  const pending = [];
  const duplicates = [];
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
  return { stocks: sortStocksByTradingValue(clean), invalid, pending, duplicates };
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
  const { stocks, invalid, pending, duplicates } = sanitizeStocks(sector.stocks || []);
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
    minuteFlowAlertCount: apiReadyStocks.filter((stock) => stock.minuteFlowAlert).length,
    validation: {
      ...(sector.validation || {}),
      status: stockOrderErrorCount === 0 ? "ok" : "warning",
      stockOrderErrorCount,
      apiPendingCount: pending.length,
      apiReadyStockCount: apiReadyStocks.length,
      numericSourcePolicy: "Realtime numeric provider focus-40 only; Naver numeric fields ignored",
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
      acc.minuteFlowAlertCount += sector.minuteFlowAlertCount || 0;
      return acc;
    },
    { tradingValueMillion: 0, volume: 0, stockCount: 0, apiReadyStockCount: 0, apiPendingCount: 0, minuteFlowAlertCount: 0 }
  );
}

function sanitizeSnapshot(snapshot) {
  primeFocus(snapshot);
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
    provider: "Realtime numeric provider focus-40 + Naver stock list",
    rankingBasis: "top-8-sectors-x-top-5-stocks-realtime-focus",
    validationMethod: "Naver selects focus candidates; realtime numeric provider supplies displayed volume/trading value",
    focusPolicy: { topSectors: FOCUS_SECTOR_COUNT, topStocksPerSector: FOCUS_STOCKS_PER_SECTOR, maxCodes: FOCUS_MAX_CODES, codes: lastFocusCodes, updatedAt: lastFocusUpdatedAt },
    minuteFlowPolicy: { thresholdMillion: 1_000, levels: FLOW_LEVELS, unit: "million KRW per minute" },
    excludes: ["ETF", "ETN", "ELW", "invalid stock code rows", "Naver volume/trading-value numbers"],
    sectors,
    totals,
    validation: {
      ...validation,
      status: orderErrorCount === 0 ? "ok" : "warning",
      errorCount: orderErrorCount,
      apiReadyStockCount: totals.apiReadyStockCount,
      apiPendingCount: totals.apiPendingCount,
      minuteFlowAlertCount: totals.minuteFlowAlertCount,
      backfill: getBackfillStatus(),
      realtime: getRealtimeStatus(),
      numericSourcePolicy: "Focus-40 realtime numeric display; Naver numeric fields ignored"
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
    provider: "Realtime numeric provider focus-40 + Naver stock list",
    overviewProvider: "Yahoo Finance",
    rankingBasis: "top-8-sectors-x-top-5-stocks-realtime-focus",
    validationMethod: "Naver selects focus candidates; realtime numeric provider supplies displayed volume/trading value",
    focusPolicy: { topSectors: FOCUS_SECTOR_COUNT, topStocksPerSector: FOCUS_STOCKS_PER_SECTOR, maxCodes: FOCUS_MAX_CODES, codes: lastFocusCodes },
    minuteFlowPolicy: { thresholdMillion: 1_000, levels: FLOW_LEVELS, unit: "million KRW per minute" },
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
    provider: "Realtime numeric provider focus-40 + Naver stock list",
    overviewProvider: "Yahoo Finance",
    mode: "localhost-focus40-kis",
    rankingBasis: "top-8-sectors-x-top-5-stocks-realtime-focus",
    validationMethod: "Naver selects focus candidates; realtime numeric provider supplies displayed volume/trading value",
    focusPolicy: { topSectors: FOCUS_SECTOR_COUNT, topStocksPerSector: FOCUS_STOCKS_PER_SECTOR, maxCodes: FOCUS_MAX_CODES, codes: lastFocusCodes, updatedAt: lastFocusUpdatedAt },
    minuteFlowPolicy: { thresholdMillion: 1_000, levels: FLOW_LEVELS, unit: "million KRW per minute" },
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
    const detailed = await getSectorDetail(sector, { force: request.query.force === "1", kisStockLimit: 0 });
    response.json(recalculateSector(detailed));
  } catch (error) {
    response.status(502).json({ error: error.message, realtime: getRealtimeStatus(), backfill: getBackfillStatus() });
  }
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
  console.log("Provider: Realtime numeric provider focus-40 + Naver stock list");
  console.log(`Focus policy: topSectors=${FOCUS_SECTOR_COUNT}, topStocksPerSector=${FOCUS_STOCKS_PER_SECTOR}, maxCodes=${FOCUS_MAX_CODES}`);
  console.log("Minute flow policy: 10억/min watch, 30억/min strong, 50억/min ultra");
  console.log(`KIS status: ${JSON.stringify(getKisStatus())}`);
  console.log(`Realtime status: ${JSON.stringify(getRealtimeStatus())}`);
  console.log(`Backfill status: ${JSON.stringify(getBackfillStatus())}`);
  console.log(`Stream push: ${STREAM_PUSH_MS}ms, market cache: ${MARKET_CACHE_MS}ms, overview cache: ${OVERVIEW_CACHE_MS}ms.`);
});
