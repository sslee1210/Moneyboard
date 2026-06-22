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

const app = express();
const PORT = Number(process.env.PORT || 4173);
const STREAM_PUSH_MS = Number(process.env.STREAM_PUSH_MS || 2_000);
const MARKET_CACHE_MS = Number(process.env.MARKET_CACHE_MS || 10_000);
const OVERVIEW_CACHE_MS = Number(process.env.OVERVIEW_CACHE_MS || 5_000);
const STOCK_CODE_PATTERN = /^\d{6}$/;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function isValidStockCode(code) {
  return STOCK_CODE_PATTERN.test(String(code || ""));
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
  const cleanStocks = [];

  for (const stock of stocks || []) {
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
    cleanStocks.push({ ...stock, code });
  }

  return {
    stocks: sortStocksByTradingValue(cleanStocks),
    invalidStocks,
    duplicateStocks
  };
}

function recalculateSector(sector) {
  const { stocks, invalidStocks, duplicateStocks } = sanitizeStocks(sector.stocks || []);
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
  const invalidStockCount = invalidStocks.length;
  const duplicateStockCount = duplicateStocks.length;

  return {
    ...sector,
    stockCount: stocks.length,
    invalidStockCount,
    duplicateStockCount,
    droppedStockCount: invalidStockCount + duplicateStockCount,
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
    validation: {
      ...(sector.validation || {}),
      status: unverifiedTradeAmountCount === 0 && stockOrderErrorCount === 0 ? "ok" : "warning",
      stockOrderErrorCount,
      invalidStockCount,
      duplicateStockCount,
      droppedStockCount: invalidStockCount + duplicateStockCount,
      repairedTradeAmountCount,
      derivedTradeAmountCount,
      unverifiedTradeAmountCount,
      kisVerifiedCount,
      validationStatusCounts
    },
    updatedAt: new Date().toISOString()
  };
}

function buildTotals(sectors = []) {
  return sectors.reduce(
    (acc, sector) => {
      acc.tradingValueMillion += sector.tradingValueMillion || 0;
      acc.volume += sector.volume || 0;
      acc.stockCount += sector.stockCount || 0;
      acc.excludedEtfEtnCount += sector.excludedEtfEtnCount || 0;
      acc.repairedTradeAmountCount += sector.repairedTradeAmountCount || 0;
      acc.derivedTradeAmountCount += sector.derivedTradeAmountCount || 0;
      acc.unverifiedTradeAmountCount += sector.unverifiedTradeAmountCount || 0;
      acc.kisVerifiedCount += sector.kisVerifiedCount || 0;
      acc.kisErrorCount += sector.kisErrorCount || 0;
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
      sectorCount: sectors.length,
      excludedEtfEtnCount: 0,
      repairedTradeAmountCount: 0,
      derivedTradeAmountCount: 0,
      unverifiedTradeAmountCount: 0,
      kisVerifiedCount: 0,
      kisErrorCount: 0,
      invalidStockCount: 0,
      duplicateStockCount: 0,
      breadth: { rising: 0, flat: 0, falling: 0 }
    }
  );
}

function sanitizeSnapshot(snapshot) {
  const sectors = sortSectorsByTradingValue((snapshot.sectors || []).map(recalculateSector)).map((sector, index) => ({
    ...sector,
    rank: index + 1
  }));
  const validation = buildSnapshotValidation(sectors);
  const invalidStockCount = sectors.reduce((sum, sector) => sum + (sector.invalidStockCount || 0), 0);
  const duplicateStockCount = sectors.reduce((sum, sector) => sum + (sector.duplicateStockCount || 0), 0);

  return {
    ...snapshot,
    sectors,
    totals: buildTotals(sectors),
    validation: {
      ...validation,
      invalidStockCount,
      duplicateStockCount,
      droppedStockCount: invalidStockCount + duplicateStockCount,
      sanitizer: "final API response sanitizer: valid six-digit stock codes only"
    }
  };
}

async function buildSanitizedMarketSnapshot(force = false) {
  return sanitizeSnapshot(await getMarketSnapshot(force));
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
    provider: KIS_ENABLED ? "KIS Open API + Naver Finance" : "Naver Finance",
    overviewProvider: "Yahoo Finance",
    mode: "localhost-live-sanitized",
    rankingBasis: KIS_ENABLED ? "kis-verified-daily-trading-value" : "validated-daily-trading-value",
    validationMethod: KIS_ENABLED
      ? "KIS REST quote overlay + Naver header-aligned parser fallback + final code sanitizer"
      : "header-aligned parser + candidate-column validation + price-volume fallback + final code sanitizer",
    excludes: ["ETF", "ETN", "ELW", "invalid stock code rows"],
    refreshMs: STREAM_PUSH_MS,
    marketCacheMs: MARKET_CACHE_MS,
    overviewCacheMs: OVERVIEW_CACHE_MS,
    kis: getKisStatus()
  });
});

app.get("/api/kis/status", (_request, response) => {
  response.json(getKisStatus());
});

app.get("/api/kis/quote/:code", async (request, response) => {
  try {
    response.json(await fetchKisQuote(request.params.code, { force: request.query.force === "1" }));
  } catch (error) {
    response.status(KIS_ENABLED ? 502 : 400).json({
      status: "error",
      error: error.message,
      kis: getKisStatus()
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
    response.status(502).json({ error: error.message });
  }
});

app.get("/api/validation", async (request, response) => {
  try {
    const snapshot = await buildSanitizedMarketSnapshot(request.query.force === "1");
    response.status(snapshot.validation.status === "ok" ? 200 : 409).json(snapshot.validation);
  } catch (error) {
    response.status(502).json({ status: "error", error: error.message });
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
    response.status(502).json({ error: error.message });
  }
});

app.post("/api/volume-profile", (request, response) => {
  const stocks = sortStocksByTradingValue((request.body?.stocks || []).filter((stock) => isValidStockCode(stock?.code)));
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
    updatedAt: new Date().toISOString()
  });
});

app.get("/api/stream", async (request, response) => {
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-cache, no-transform");
  response.setHeader("connection", "keep-alive");
  response.flushHeaders?.();

  let closed = false;
  request.on("close", () => {
    closed = true;
  });

  const send = async () => {
    if (closed) return;
    try {
      const snapshot = await buildSanitizedMarketSnapshot(false);
      response.write(`event: market\n`);
      response.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    } catch (error) {
      response.write(`event: error\n`);
      response.write(`data: ${JSON.stringify({ error: error.message, updatedAt: new Date().toISOString() })}\n\n`);
    }
  };

  await send();
  const interval = setInterval(send, STREAM_PUSH_MS);
  request.on("close", () => clearInterval(interval));
});

app.use(express.static(path.join(__dirname, "dist")));
app.get(/.*/, (_request, response) => {
  response.sendFile(path.join(__dirname, "dist", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Moneyboard sanitized local server listening on http://localhost:${PORT}`);
  console.log(`Provider: ${KIS_ENABLED ? "KIS Open API + Naver Finance fallback" : "Naver Finance only. KIS is disabled."}`);
  console.log(`KIS status: ${JSON.stringify(getKisStatus())}`);
  console.log("Ranking basis: validated daily trading value. ETF/ETN/ELW/invalid-code rows excluded.");
  console.log(`Stream push: ${STREAM_PUSH_MS}ms, market cache: ${MARKET_CACHE_MS}ms, overview cache: ${OVERVIEW_CACHE_MS}ms.`);
});
