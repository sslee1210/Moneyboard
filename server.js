import express from "express";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const PORT = Number(process.env.PORT || 4173);
const NAVER_BASE_URL = "https://finance.naver.com";
const READER_BASE_URL = "https://r.jina.ai/http://finance.naver.com";
const MARKET_CACHE_MS = Number(process.env.MARKET_CACHE_MS || 30_000);
const DETAIL_CACHE_MS = Number(process.env.DETAIL_CACHE_MS || 20_000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 12_000);
const DETAIL_CONCURRENCY = Number(process.env.DETAIL_CONCURRENCY || 8);
const VOLUME_HISTORY_LIMIT = Number(process.env.VOLUME_HISTORY_LIMIT || 12);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const marketCache = { data: null, expiresAt: 0, promise: null };
const detailCache = new Map();

const allowedOrigins = new Set([
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://sslee1210.github.io"
]);

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (allowedOrigins.has(origin)) return true;
  try {
    return new URL(origin).hostname.endsWith(".github.io");
  } catch {
    return false;
  }
}

function compactText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanCell(value) {
  return compactText(value)
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/_/g, "");
}

function parseNumber(value) {
  const normalized = compactText(value).replace(/,/g, "").replace(/[^\d.-]/g, "");
  if (!normalized || normalized === "-" || normalized === ".") return 0;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function parsePercent(value) {
  return parseNumber(value);
}

function formatNaverPath(pathname) {
  return pathname.startsWith("http") ? pathname : `${NAVER_BASE_URL}${pathname}`;
}

function formatReaderPath(pathname) {
  const separator = pathname.includes("?") ? "&" : "?";
  return `${READER_BASE_URL}${pathname}${separator}t=${Date.now()}`;
}

async function fetchHtml(pathname) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(formatNaverPath(pathname), {
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml",
        "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.6,en;q=0.4",
        "cache-control": "no-cache",
        referer: `${NAVER_BASE_URL}/sise/`,
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
      }
    });

    if (!response.ok) throw new Error(`Naver Finance responded with ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") || "";
    const charset = contentType.match(/charset=([^;]+)/i)?.[1]?.toLowerCase() || "";

    if (charset.includes("euc-kr") || charset.includes("ks_c_5601") || charset.includes("cp949")) {
      return iconv.decode(buffer, "euc-kr");
    }

    const utf8Text = buffer.toString("utf8");
    return utf8Text.includes("�") ? iconv.decode(buffer, "euc-kr") : utf8Text;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchReaderText(pathname) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS + 10_000);

  try {
    const response = await fetch(formatReaderPath(pathname), {
      signal: controller.signal,
      headers: { accept: "text/plain, text/markdown" }
    });
    if (!response.ok) throw new Error(`Naver reader responded with ${response.status}`);
    return response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function splitRow(row) {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function parseSectorList(html) {
  const $ = cheerio.load(html);
  const sectors = [];
  const seen = new Set();

  $('a[href*="sise_group_detail.naver?type=upjong&no="]').each((_, anchor) => {
    const href = $(anchor).attr("href") || "";
    const url = new URL(href, NAVER_BASE_URL);
    const id = url.searchParams.get("no");
    const name = compactText($(anchor).text());
    const cells = $(anchor)
      .closest("tr")
      .find("td")
      .map((__, cell) => compactText($(cell).text()))
      .get();

    if (!id || !name || seen.has(id) || cells.length < 6) return;
    seen.add(id);

    sectors.push({
      id,
      name,
      changeRate: parsePercent(cells[1]),
      stockCount: parseNumber(cells[2]),
      risingCount: parseNumber(cells[3]),
      flatCount: parseNumber(cells[4]),
      fallingCount: parseNumber(cells[5]),
      naverUrl: `${NAVER_BASE_URL}${url.pathname}${url.search}`
    });
  });

  return sectors;
}

function parseHtmlStockRows(html) {
  const $ = cheerio.load(html);
  const stocks = [];
  const seen = new Set();

  $('a[href*="/item/main.naver?code="]').each((_, linkEl) => {
    const link = $(linkEl);
    const row = link.closest("tr");
    const href = link.attr("href") || "";
    const url = new URL(href, NAVER_BASE_URL);
    const code = url.searchParams.get("code");
    const name = compactText(link.text());
    const cells = row
      .children("td")
      .map((__, cell) => compactText($(cell).text()))
      .get();

    if (!code || !/^\d{6}$/.test(code) || !name || seen.has(code) || cells.length < 8) return;
    seen.add(code);

    const nameIndex = cells.findIndex((cell) => cell.includes(name));
    const offset = nameIndex >= 0 ? nameIndex : 0;
    const price = parseNumber(cells[offset + 1]);
    const changeAmount = parseNumber(cells[offset + 2]);
    const changeRate = parsePercent(cells[offset + 3]);
    const bid = parseNumber(cells[offset + 4]);
    const ask = parseNumber(cells[offset + 5]);
    const volume = parseNumber(cells[offset + 6]);
    const tradeAmountMillion = parseNumber(cells[offset + 7]);
    const previousVolume = parseNumber(cells[offset + 8]);

    stocks.push({
      code,
      name,
      price,
      changeAmount,
      changeRate,
      bid,
      ask,
      volume,
      tradeAmountMillion,
      previousVolume,
      market: compactText(row.find(".dot").text()) === "*" ? "KOSDAQ" : "KOSPI",
      direction: changeRate > 0 ? "up" : changeRate < 0 ? "down" : "flat",
      provider: "Naver Finance",
      naverUrl: `${NAVER_BASE_URL}/item/main.naver?code=${code}`
    });
  });

  stocks.sort((left, right) => right.tradeAmountMillion - left.tradeAmountMillion);
  return stocks;
}

function parseReaderStockRows(markdown) {
  const stocks = [];
  const seen = new Set();

  markdown
    .split(/\r?\n/)
    .filter((line) => line.includes("/item/main.naver?code=") && line.includes("|"))
    .forEach((line) => {
      const rawCells = splitRow(line).map(cleanCell);
      const firstCell = rawCells.find((cell) => cell.includes("/item/main.naver?code=")) || rawCells[0] || "";
      const match = firstCell.match(
        /\[([^\]]+)\]\(https?:\/\/finance\.naver\.com\/item\/main\.naver\?code=(\d{6})\)(\*)?/
      );

      if (!match || rawCells.length < 9 || seen.has(match[2])) return;
      seen.add(match[2]);

      const changeRate = parseNumber(rawCells[3]);
      stocks.push({
        code: match[2],
        name: compactText(match[1]),
        price: parseNumber(rawCells[1]),
        changeAmount: parseNumber(rawCells[2]),
        changeRate,
        bid: parseNumber(rawCells[4]),
        ask: parseNumber(rawCells[5]),
        volume: parseNumber(rawCells[6]),
        tradeAmountMillion: parseNumber(rawCells[7]),
        previousVolume: parseNumber(rawCells[8]),
        market: match[3] ? "KOSDAQ" : "KOSPI",
        direction: changeRate > 0 ? "up" : changeRate < 0 ? "down" : "flat",
        provider: "Naver Finance reader fallback",
        naverUrl: `${NAVER_BASE_URL}/item/main.naver?code=${match[2]}`
      });
    });

  stocks.sort((left, right) => right.tradeAmountMillion - left.tradeAmountMillion);
  return stocks;
}

function buildDetailFromStocks(sector, stocks, provider = "Naver Finance") {
  const tradingValueMillion = stocks.reduce((sum, stock) => sum + stock.tradeAmountMillion, 0);
  const volume = stocks.reduce((sum, stock) => sum + stock.volume, 0);
  const weightedChangeRate =
    tradingValueMillion > 0
      ? stocks.reduce((sum, stock) => sum + stock.changeRate * stock.tradeAmountMillion, 0) / tradingValueMillion
      : sector.changeRate;

  return {
    ...sector,
    tradingValueMillion,
    volume,
    weightedChangeRate,
    topStocks: stocks.slice(0, 8),
    stocks,
    provider,
    fetchedAt: new Date().toISOString()
  };
}

function parseSectorDetail(html, sector) {
  return buildDetailFromStocks(sector, parseHtmlStockRows(html), "Naver Finance");
}

function parseReaderSectorDetail(markdown, sector) {
  return buildDetailFromStocks(sector, parseReaderStockRows(markdown), "Naver Finance reader fallback");
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

async function getSectorDetail(sector, options = false) {
  const force = typeof options === "boolean" ? options : Boolean(options.force);
  const cacheKey = sector.id;
  const cached = detailCache.get(cacheKey);

  if (!force && cached?.data && cached.expiresAt > Date.now()) return cached.data;
  if (!force && cached?.promise) return cached.promise;

  const promise = fetchHtml(`/sise/sise_group_detail.naver?type=upjong&no=${sector.id}`)
    .then(async (html) => {
      const direct = parseSectorDetail(html, sector);
      if (direct.stocks.length > 0 && direct.tradingValueMillion > 0) return direct;

      const markdown = await fetchReaderText(`/sise/sise_group_detail.naver?type=upjong&no=${sector.id}`);
      const fallback = parseReaderSectorDetail(markdown, sector);
      if (fallback.stocks.length > 0) return fallback;
      return { ...direct, error: "Naver detail parser returned no stock rows" };
    })
    .then((data) => {
      detailCache.set(cacheKey, { data, expiresAt: Date.now() + DETAIL_CACHE_MS, promise: null });
      return data;
    })
    .catch((error) => {
      const fallback = cached?.data || {
        ...sector,
        tradingValueMillion: 0,
        volume: 0,
        weightedChangeRate: sector.changeRate,
        topStocks: [],
        stocks: [],
        provider: "Naver Finance",
        fetchedAt: new Date().toISOString(),
        error: error.message
      };
      detailCache.set(cacheKey, {
        data: fallback,
        expiresAt: Date.now() + Math.min(DETAIL_CACHE_MS, 10_000),
        promise: null
      });
      return fallback;
    });

  detailCache.set(cacheKey, { data: cached?.data, expiresAt: cached?.expiresAt || 0, promise });
  return promise;
}

function summarizeSector(detail) {
  const topStock = detail.topStocks?.[0] || null;
  return {
    id: detail.id,
    name: detail.name,
    changeRate: detail.changeRate,
    weightedChangeRate: detail.weightedChangeRate,
    stockCount: detail.stockCount,
    risingCount: detail.risingCount,
    flatCount: detail.flatCount,
    fallingCount: detail.fallingCount,
    tradingValueMillion: detail.tradingValueMillion,
    volume: detail.volume,
    topStocks: detail.topStocks,
    topStockName: topStock?.name || null,
    topStockCode: topStock?.code || null,
    naverUrl: detail.naverUrl,
    error: detail.error || null
  };
}

async function buildMarketSnapshot() {
  const sectorHtml = await fetchHtml("/sise/sise_group.naver?type=upjong");
  const sectors = parseSectorList(sectorHtml);
  const details = await mapLimit(sectors, DETAIL_CONCURRENCY, (sector) => getSectorDetail(sector));
  const summaries = details.map(summarizeSector).sort((a, b) => b.tradingValueMillion - a.tradingValueMillion);
  const totalTradingValueMillion = summaries.reduce((sum, sector) => sum + sector.tradingValueMillion, 0);
  const totalVolume = summaries.reduce((sum, sector) => sum + sector.volume, 0);
  const breadth = summaries.reduce(
    (acc, sector) => {
      acc.rising += sector.risingCount;
      acc.flat += sector.flatCount;
      acc.falling += sector.fallingCount;
      return acc;
    },
    { rising: 0, flat: 0, falling: 0 }
  );

  return {
    updatedAt: new Date().toISOString(),
    mode: "localhost-live",
    source: {
      name: "Naver Finance",
      url: `${NAVER_BASE_URL}/sise/sise_group.naver?type=upjong`,
      tradingValueUnit: "millionKRW"
    },
    totals: {
      sectorCount: summaries.length,
      tradingValueMillion: totalTradingValueMillion,
      volume: totalVolume,
      breadth
    },
    sectors: summaries
  };
}

async function getMarketSnapshot() {
  if (marketCache.data && marketCache.expiresAt > Date.now()) return marketCache.data;
  if (marketCache.promise) return marketCache.promise;

  marketCache.promise = buildMarketSnapshot()
    .then((data) => {
      marketCache.data = data;
      marketCache.expiresAt = Date.now() + MARKET_CACHE_MS;
      marketCache.promise = null;
      return data;
    })
    .catch((error) => {
      marketCache.promise = null;
      if (marketCache.data) return { ...marketCache.data, stale: true, error: error.message };
      throw error;
    });

  return marketCache.promise;
}

function buildVolumeProfile(stocks, limit = VOLUME_HISTORY_LIMIT) {
  const items = (stocks || []).slice(0, limit).map((stock) => ({
    code: stock.code,
    name: stock.name,
    day: stock.volume || 0,
    week: stock.periodVolumes?.week ?? null,
    month: stock.periodVolumes?.month ?? null
  }));

  return {
    sampleSize: items.length,
    limit,
    provider: "Naver Finance day-volume only",
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
  };
}

app.use((request, response, next) => {
  const origin = request.headers.origin;
  if (isAllowedOrigin(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (request.method === "OPTIONS") {
    response.sendStatus(204);
    return;
  }
  next();
});

app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_, response) => {
  response.json({ ok: true, mode: "localhost-live", provider: "Naver Finance", now: new Date().toISOString() });
});

app.get("/api/provider", (_, response) => {
  response.json({
    market: "Naver Finance",
    sectorDetail: "Naver Finance + reader fallback",
    volumeProfile: "Naver Finance day-volume only",
    kis: { configured: false, enabled: false }
  });
});

app.get("/api/sectors", async (_, response) => {
  try {
    response.json(await getMarketSnapshot());
  } catch (error) {
    response.status(502).json({ message: "Failed to load market data", error: error.message });
  }
});

app.get("/api/sectors/:id", async (request, response) => {
  try {
    const snapshot = await getMarketSnapshot();
    const sector = snapshot.sectors.find((item) => item.id === request.params.id);
    if (!sector) {
      response.status(404).json({ message: "Sector not found" });
      return;
    }
    response.json(await getSectorDetail(sector, { force: true }));
  } catch (error) {
    response.status(502).json({ message: "Failed to load sector detail", error: error.message });
  }
});

app.post("/api/volume-profile", (request, response) => {
  const stocks = Array.isArray(request.body?.stocks) ? request.body.stocks : [];
  const limit = Number(request.body?.limit || VOLUME_HISTORY_LIMIT);
  response.json(buildVolumeProfile(stocks, limit));
});

app.get("/api/stream", async (request, response) => {
  response.writeHead(200, {
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream",
    "X-Accel-Buffering": "no"
  });

  const sendSnapshot = async () => {
    try {
      const payload = await getMarketSnapshot();
      response.write("event: market\n");
      response.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (error) {
      response.write("event: error\n");
      response.write(`data: ${JSON.stringify({ message: error.message })}\n\n`);
    }
  };

  await sendSnapshot();
  const interval = setInterval(sendSnapshot, MARKET_CACHE_MS);
  request.on("close", () => clearInterval(interval));
});

app.use(express.static(path.join(__dirname, "dist")));

app.use((request, response, next) => {
  if (request.method !== "GET") {
    next();
    return;
  }
  response.sendFile(path.join(__dirname, "dist", "index.html"));
});

export { app, buildMarketSnapshot, getMarketSnapshot, getSectorDetail };

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  app.listen(PORT, () => {
    console.log(`Moneyboard live server listening on http://localhost:${PORT}`);
    console.log("Provider: Naver Finance only. KIS is disabled.");
    console.log("Sector detail parser: direct Naver HTML + reader fallback.");
  });
}
