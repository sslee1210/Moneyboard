import express from "express";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  enrichSectorWithKis,
  fetchKisQuote,
  getKisStatus,
  KIS_ENABLED,
  KIS_MARKET_VERIFY_TOP_SECTORS,
  KIS_MARKET_VERIFY_TOP_STOCKS,
  KIS_SELECTED_SECTOR_STOCKS
} from "./kis-provider.js";

const app = express();
const PORT = Number(process.env.PORT || 4173);
const NAVER_BASE_URL = "https://finance.naver.com";

// Browser receives a new snapshot every second. Upstream pages are cached very
// briefly so refresh remains fast without stacking duplicate requests.
const STREAM_PUSH_MS = Number(process.env.STREAM_PUSH_MS || 1_000);
const MARKET_CACHE_MS = Number(process.env.MARKET_CACHE_MS || 1_000);
const OVERVIEW_CACHE_MS = Number(process.env.OVERVIEW_CACHE_MS || 5_000);
const DETAIL_CACHE_MS = Number(process.env.DETAIL_CACHE_MS || 3_000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 8_000);
const DETAIL_CONCURRENCY = Number(process.env.DETAIL_CONCURRENCY || 4);
const VOLUME_HISTORY_LIMIT = Number(process.env.VOLUME_HISTORY_LIMIT || 12);

// Parsed 거래대금 must be internally consistent with 현재가 × 거래량. If not,
// the parser treats it as a wrong-column read and uses a verified fallback.
const TRADE_VALUE_MIN_RATIO = Number(process.env.TRADE_VALUE_MIN_RATIO || 0.55);
const TRADE_VALUE_MAX_RATIO = Number(process.env.TRADE_VALUE_MAX_RATIO || 1.85);

const OVERVIEW_INSTRUMENTS = [
  { id: "kospi", label: "코스피", symbol: "^KS11", provider: "Yahoo Finance" },
  { id: "kosdaq", label: "코스닥", symbol: "^KQ11", provider: "Yahoo Finance" },
  { id: "nasdaq100-futures", label: "나스닥100 선물", symbol: "NQ=F", provider: "Yahoo Finance" },
  { id: "usd-krw", label: "달러 환율", symbol: "KRW=X", provider: "Yahoo Finance", kind: "fx" },
  { id: "sp500", label: "S&P500", symbol: "^GSPC", provider: "Yahoo Finance" }
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const marketCache = { data: null, expiresAt: 0, promise: null };
const overviewCache = { data: null, expiresAt: 0, promise: null };
const detailCache = new Map();

function compactText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

async function fetchJsonUrl(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json,text/plain,*/*",
        "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.6,en;q=0.4",
        "cache-control": "no-cache",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
      }
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function yahooChartUrl(symbol) {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=5d&interval=30m&includePrePost=true`;
}

function normalizeChartPoints(result) {
  const timestamps = result?.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];

  return timestamps
    .map((timestamp, index) => ({
      time: new Date(timestamp * 1000).toISOString(),
      value: Number(closes[index])
    }))
    .filter((point) => Number.isFinite(point.value));
}

function ensureSparklinePoints(points, current, previous) {
  const clean = (points || []).filter((point) => Number.isFinite(point.value)).slice(-64);
  const distinctValues = new Set(clean.map((point) => Math.round(point.value * 10000) / 10000));

  if (clean.length >= 3 && distinctValues.size > 1) return clean;

  const now = Date.now();
  const prev = Number.isFinite(previous) && previous > 0 ? previous : current;
  const curr = Number.isFinite(current) && current > 0 ? current : prev;

  if (!Number.isFinite(prev) || !Number.isFinite(curr)) return clean;

  return [
    { time: new Date(now - 60 * 60 * 1000).toISOString(), value: prev },
    { time: new Date(now - 30 * 60 * 1000).toISOString(), value: (prev + curr) / 2 },
    { time: new Date(now).toISOString(), value: curr }
  ];
}

async function fetchOverviewInstrument(instrument) {
  const json = await fetchJsonUrl(yahooChartUrl(instrument.symbol));
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`${instrument.label} chart unavailable`);

  const rawPoints = normalizeChartPoints(result);
  const meta = result.meta || {};
  const current = Number(meta.regularMarketPrice ?? rawPoints.at(-1)?.value ?? meta.previousClose ?? 0);
  const previous = Number(meta.chartPreviousClose ?? meta.previousClose ?? rawPoints[0]?.value ?? current);
  const change = current - previous;
  const changeRate = previous ? (change / previous) * 100 : 0;
  const points = ensureSparklinePoints(rawPoints, current, previous);

  return {
    id: instrument.id,
    label: instrument.label,
    symbol: instrument.symbol,
    provider: instrument.provider,
    kind: instrument.kind || "index",
    value: Number.isFinite(current) ? current : null,
    previousClose: Number.isFinite(previous) ? previous : null,
    change: Number.isFinite(change) ? change : 0,
    changeRate: Number.isFinite(changeRate) ? changeRate : 0,
    points,
    pointCount: points.length,
    dataQuality: points.length >= 3 ? "ok" : "thin",
    delayed: true,
    updatedAt: new Date().toISOString()
  };
}

async function buildMarketOverview(force = false) {
  if (!force && overviewCache.data && overviewCache.expiresAt > Date.now()) return overviewCache.data;
  if (!force && overviewCache.promise) return overviewCache.promise;

  const promise = Promise.allSettled(OVERVIEW_INSTRUMENTS.map(fetchOverviewInstrument)).then((results) => ({
    provider: "Yahoo Finance",
    refreshMs: OVERVIEW_CACHE_MS,
    delayed: true,
    updatedAt: new Date().toISOString(),
    items: results.map((result, index) => {
      const base = OVERVIEW_INSTRUMENTS[index];
      if (result.status === "fulfilled") return result.value;

      return {
        id: base.id,
        label: base.label,
        symbol: base.symbol,
        provider: base.provider,
        kind: base.kind || "index",
        value: null,
        previousClose: null,
        change: 0,
        changeRate: 0,
        points: [],
        pointCount: 0,
        dataQuality: "error",
        delayed: true,
        error: result.reason?.message || "overview unavailable",
        updatedAt: new Date().toISOString()
      };
    })
  }));

  overviewCache.promise = promise;

  try {
    const data = await promise;
    overviewCache.data = data;
    overviewCache.expiresAt = Date.now() + OVERVIEW_CACHE_MS;
    return data;
  } finally {
    overviewCache.promise = null;
  }
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

function isEtfOrEtnStock(stock) {
  const name = compactText(stock?.name || "");

  return (
    /\b(ETF|ETN|ELW)\b/i.test(name) ||
    /^(KODEX|TIGER|ACE|RISE|KBSTAR|SOL|KOSEF|HANARO|ARIRANG|TIMEFOLIO|FOCUS|히어로즈|TREX|마이티|WOORI|파워|UNICORN)\b/i.test(name) ||
    /(레버리지|인버스|선물|합성|커버드콜|액티브|TR\b|채권혼합|원자재|금선물|은선물|구리선물|원유선물|달러선물)/i.test(name)
  );
}

function sortStocksByTradingValue(stocks = []) {
  return [...stocks].sort((left, right) => {
    const tradingGap = (right.tradeAmountMillion || 0) - (left.tradeAmountMillion || 0);
    if (tradingGap !== 0) return tradingGap;
    return (right.volume || 0) - (left.volume || 0);
  });
}

function sortStocksByVolume(stocks = []) {
  return [...stocks].sort((left, right) => {
    const volumeGap = (right.volume || 0) - (left.volume || 0);
    if (volumeGap !== 0) return volumeGap;
    return (right.tradeAmountMillion || 0) - (left.tradeAmountMillion || 0);
  });
}

function getTableHeaders($, row) {
  const table = row.closest("table");
  return table
    .find("tr")
    .filter((_, candidate) => $(candidate).find("th").length > 0)
    .first()
    .find("th")
    .map((_, header) => compactText($(header).text()))
    .get();
}

function headerIndex(headers, matcher) {
  const index = headers.findIndex((header) => matcher(header));
  return index >= 0 ? index : null;
}

function alignedHeaderIndex(headers, cells, matcher, nameIndex = 0) {
  const index = headerIndex(headers, matcher);
  if (index === null) return null;

  const nameHeaderIndex = headerIndex(headers, (header) => /종목/.test(header));
  if (nameHeaderIndex !== null) {
    const aligned = index - nameHeaderIndex + nameIndex;
    if (aligned >= 0 && aligned < cells.length) return aligned;
  }

  if (index >= 0 && index < cells.length) return index;
  return null;
}

function cellAt(cells, index) {
  if (index === null || index === undefined || index < 0 || index >= cells.length) return "";
  return cells[index];
}

function estimateTradeAmountMillion(price, volume) {
  const estimate = (Number(price || 0) * Number(volume || 0)) / 1_000_000;
  return Number.isFinite(estimate) && estimate > 0 ? estimate : 0;
}

function validationRatio(value, estimate) {
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(estimate) || estimate <= 0) return null;
  return value / estimate;
}

function isTradeAmountRatioValid(ratio) {
  return ratio !== null && ratio >= TRADE_VALUE_MIN_RATIO && ratio <= TRADE_VALUE_MAX_RATIO;
}

function chooseVerifiedTradeAmountMillion({ cells, preferredIndex, price, volume, volumeIndex }) {
  const rawTradeAmountMillion = parseNumber(cellAt(cells, preferredIndex));
  const estimatedTradeAmountMillion = estimateTradeAmountMillion(price, volume);
  const rawRatio = validationRatio(rawTradeAmountMillion, estimatedTradeAmountMillion);

  if (rawTradeAmountMillion > 0 && isTradeAmountRatioValid(rawRatio)) {
    return {
      tradeAmountMillion: rawTradeAmountMillion,
      rawTradeAmountMillion,
      estimatedTradeAmountMillion,
      status: "parsed-header",
      ratio: rawRatio,
      tradeAmountColumn: preferredIndex
    };
  }

  const candidates = cells
    .map((text, index) => {
      const value = parseNumber(text);
      const ratio = validationRatio(value, estimatedTradeAmountMillion);
      return { index, value, ratio };
    })
    .filter(
      (candidate) =>
        candidate.value > 0 &&
        candidate.index !== volumeIndex &&
        candidate.index > (volumeIndex ?? -1) &&
        isTradeAmountRatioValid(candidate.ratio)
    )
    .sort((left, right) => Math.abs(Math.log(left.ratio)) - Math.abs(Math.log(right.ratio)));

  if (candidates.length) {
    const best = candidates[0];
    return {
      tradeAmountMillion: best.value,
      rawTradeAmountMillion,
      estimatedTradeAmountMillion,
      status: preferredIndex === best.index ? "parsed-header" : "parsed-candidate",
      ratio: best.ratio,
      tradeAmountColumn: best.index,
      preferredTradeAmountColumn: preferredIndex
    };
  }

  if (estimatedTradeAmountMillion > 0) {
    return {
      tradeAmountMillion: estimatedTradeAmountMillion,
      rawTradeAmountMillion,
      estimatedTradeAmountMillion,
      status: rawTradeAmountMillion > 0 ? "repaired-price-volume" : "derived-price-volume",
      ratio: rawRatio,
      tradeAmountColumn: preferredIndex
    };
  }

  return {
    tradeAmountMillion: 0,
    rawTradeAmountMillion,
    estimatedTradeAmountMillion,
    status: "unverified",
    ratio: rawRatio,
    tradeAmountColumn: preferredIndex
  };
}

function normalizeTradingValue(stock, metadata = {}) {
  const verified = chooseVerifiedTradeAmountMillion({
    cells: metadata.cells || [],
    preferredIndex: metadata.tradeAmountColumn,
    price: stock.price,
    volume: stock.volume,
    volumeIndex: metadata.volumeColumn
  });

  return {
    ...stock,
    rawTradeAmountMillion: verified.rawTradeAmountMillion,
    estimatedTradeAmountMillion: verified.estimatedTradeAmountMillion,
    tradeAmountMillion: verified.tradeAmountMillion,
    dataProvider: "Naver",
    tradingValueValidation: {
      status: verified.status,
      source: "Naver Finance",
      ratio: verified.ratio,
      priceColumn: metadata.priceColumn,
      volumeColumn: metadata.volumeColumn,
      tradeAmountColumn: verified.tradeAmountColumn,
      preferredTradeAmountColumn: verified.preferredTradeAmountColumn ?? metadata.tradeAmountColumn,
      headers: metadata.headers || []
    }
  };
}

function countByValidationStatus(stocks) {
  return stocks.reduce((acc, stock) => {
    const status = stock.tradingValueValidation?.status || "unknown";
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

function parseSectorDetail(html, sector) {
  const $ = cheerio.load(html);
  const rawStocks = [];

  $("td.name").each((_, nameCell) => {
    const row = $(nameCell).closest("tr");
    const cells = row
      .children("td")
      .map((__, cell) => compactText($(cell).text()))
      .get();
    const link = $(nameCell).find('a[href*="/item/main.naver?code="]').first();
    const href = link.attr("href") || "";
    const code = new URL(href, NAVER_BASE_URL).searchParams.get("code");
    const name = compactText(link.text());
    const headers = getTableHeaders($, row);
    const nameIndex = row.children("td").index($(nameCell));

    if (!code || !name || cells.length < 5) return;

    const priceIndex = alignedHeaderIndex(headers, cells, (header) => header.includes("현재가"), nameIndex) ?? nameIndex + 1;
    const changeAmountIndex =
      alignedHeaderIndex(headers, cells, (header) => header === "전일비", nameIndex) ?? nameIndex + 2;
    const changeRateIndex =
      alignedHeaderIndex(headers, cells, (header) => header.includes("등락률"), nameIndex) ?? nameIndex + 3;
    const volumeIndex =
      alignedHeaderIndex(headers, cells, (header) => header === "거래량", nameIndex) ??
      alignedHeaderIndex(headers, cells, (header) => header.includes("거래량") && !header.includes("전일"), nameIndex) ??
      nameIndex + 4;
    const preferredTradeAmountIndex = alignedHeaderIndex(headers, cells, (header) => header.includes("거래대금"), nameIndex);
    const marketCapIndex = alignedHeaderIndex(headers, cells, (header) => header.includes("시가총액"), nameIndex);
    const marketIndex = alignedHeaderIndex(headers, cells, (header) => header === "시장" || header.includes("시장구분"), nameIndex);

    const parsed = normalizeTradingValue(
      {
        code,
        name,
        price: parseNumber(cellAt(cells, priceIndex)),
        changeAmount: parseNumber(cellAt(cells, changeAmountIndex)),
        changeRate: parsePercent(cellAt(cells, changeRateIndex)),
        volume: parseNumber(cellAt(cells, volumeIndex)),
        marketCapMillion: parseNumber(cellAt(cells, marketCapIndex)),
        market: compactText(cellAt(cells, marketIndex)) || "-",
        naverUrl: `${NAVER_BASE_URL}/item/main.naver?code=${code}`
      },
      {
        cells,
        priceColumn: priceIndex,
        volumeColumn: volumeIndex,
        tradeAmountColumn: preferredTradeAmountIndex,
        headers
      }
    );

    rawStocks.push(parsed);
  });

  const stocks = rawStocks.filter((stock) => !isEtfOrEtnStock(stock));
  const tradingValueStocks = sortStocksByTradingValue(stocks);
  const volumeStocks = sortStocksByVolume(stocks);
  const tradingValueMillion = stocks.reduce((sum, stock) => sum + (stock.tradeAmountMillion || 0), 0);
  const volume = stocks.reduce((sum, stock) => sum + (stock.volume || 0), 0);
  const weightedChangeRate =
    tradingValueMillion > 0
      ? stocks.reduce((sum, stock) => sum + (stock.changeRate || 0) * (stock.tradeAmountMillion || 0), 0) /
        tradingValueMillion
      : sector.changeRate;
  const validationStatusCounts = countByValidationStatus(stocks);
  const repairedTradeAmountCount =
    (validationStatusCounts["repaired-price-volume"] || 0) + (validationStatusCounts["parsed-candidate"] || 0);
  const derivedTradeAmountCount = validationStatusCounts["derived-price-volume"] || 0;
  const unverifiedTradeAmountCount = validationStatusCounts.unverified || 0;
  const stockOrderErrorCount = countOrderErrors(tradingValueStocks, "tradeAmountMillion");

  return {
    ...sector,
    stockCount: stocks.length,
    excludedEtfEtnCount: rawStocks.length - stocks.length,
    repairedTradeAmountCount,
    derivedTradeAmountCount,
    unverifiedTradeAmountCount,
    validationStatusCounts,
    kisVerifiedCount: 0,
    kisErrorCount: 0,
    tradingValueMillion,
    volume,
    weightedChangeRate,
    stocks: tradingValueStocks,
    topStocks: tradingValueStocks.slice(0, 8),
    topTradingValueStocks: tradingValueStocks.slice(0, 8),
    topVolumeStocks: volumeStocks.slice(0, 8),
    validation: {
      status: unverifiedTradeAmountCount === 0 && stockOrderErrorCount === 0 ? "ok" : "warning",
      source: "Naver Finance sector detail",
      method: "header-aligned parser + candidate-column validation + price-volume fallback",
      repairedTradeAmountCount,
      derivedTradeAmountCount,
      unverifiedTradeAmountCount,
      stockOrderErrorCount,
      validationStatusCounts,
      thresholds: {
        minRatio: TRADE_VALUE_MIN_RATIO,
        maxRatio: TRADE_VALUE_MAX_RATIO
      }
    },
    updatedAt: new Date().toISOString()
  };
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

async function getSectorDetail(sector, options = {}) {
  const force = typeof options === "boolean" ? options : Boolean(options.force);
  const kisStockLimit = Number(options.kisStockLimit || 0);
  const cacheKey = `${sector.id}:kis:${kisStockLimit}`;
  const cached = detailCache.get(cacheKey);

  if (!force && cached?.data && cached.expiresAt > Date.now()) return cached.data;
  if (!force && cached?.promise) return cached.promise;

  const promise = fetchHtml(`/sise/sise_group_detail.naver?type=upjong&no=${sector.id}`)
    .then((html) => parseSectorDetail(html, sector))
    .then((data) => (kisStockLimit > 0 ? enrichSectorWithKis(data, { force, stockLimit: kisStockLimit }) : data))
    .then((data) => {
      detailCache.set(cacheKey, {
        data,
        expiresAt: Date.now() + DETAIL_CACHE_MS,
        promise: null
      });
      return data;
    })
    .catch((error) => {
      detailCache.set(cacheKey, {
        data: cached?.data || null,
        expiresAt: Date.now() + 5_000,
        promise: null
      });
      if (cached?.data) return cached.data;
      throw error;
    });

  detailCache.set(cacheKey, { data: cached?.data || null, expiresAt: 0, promise });
  return promise;
}

function sortSectorsByTradingValue(sectors = []) {
  return [...sectors].sort((left, right) => {
    const tradingGap = (right.tradingValueMillion || 0) - (left.tradingValueMillion || 0);
    if (tradingGap !== 0) return tradingGap;
    return (right.volume || 0) - (left.volume || 0);
  });
}

async function enrichRankedSectorsWithKis(rankedSectors, force = false) {
  if (!KIS_ENABLED || KIS_MARKET_VERIFY_TOP_SECTORS <= 0 || KIS_MARKET_VERIFY_TOP_STOCKS <= 0) {
    return rankedSectors;
  }

  const enriched = await mapLimit(rankedSectors, Math.min(DETAIL_CONCURRENCY, 3), async (sector, index) => {
    if (index >= KIS_MARKET_VERIFY_TOP_SECTORS) return sector;
    return enrichSectorWithKis(sector, {
      force,
      stockLimit: KIS_MARKET_VERIFY_TOP_STOCKS
    });
  });

  return sortSectorsByTradingValue(enriched).map((sector, index) => ({
    ...sector,
    rank: index + 1
  }));
}

function buildSnapshotValidation(rankedSectors) {
  const sectorOrderErrorCount = countOrderErrors(rankedSectors, "tradingValueMillion");
  let stockOrderErrorCount = 0;
  let unverifiedTradeAmountCount = 0;
  let repairedTradeAmountCount = 0;
  let derivedTradeAmountCount = 0;
  let kisVerifiedCount = 0;
  let kisErrorCount = 0;
  let duplicateStockCount = 0;
  const seenCodes = new Set();
  const validationStatusCounts = {};

  for (const sector of rankedSectors) {
    stockOrderErrorCount += sector.validation?.stockOrderErrorCount || countOrderErrors(sector.stocks || [], "tradeAmountMillion");
    unverifiedTradeAmountCount += sector.unverifiedTradeAmountCount || 0;
    repairedTradeAmountCount += sector.repairedTradeAmountCount || 0;
    derivedTradeAmountCount += sector.derivedTradeAmountCount || 0;
    kisVerifiedCount += sector.kisVerifiedCount || 0;
    kisErrorCount += sector.kisErrorCount || 0;

    for (const [status, count] of Object.entries(sector.validationStatusCounts || {})) {
      validationStatusCounts[status] = (validationStatusCounts[status] || 0) + count;
    }

    for (const stock of sector.stocks || []) {
      if (seenCodes.has(stock.code)) duplicateStockCount += 1;
      seenCodes.add(stock.code);
    }
  }

  const errorCount = sectorOrderErrorCount + stockOrderErrorCount + unverifiedTradeAmountCount;

  return {
    status: errorCount === 0 ? "ok" : "warning",
    errorCount,
    sectorOrderErrorCount,
    stockOrderErrorCount,
    unverifiedTradeAmountCount,
    repairedTradeAmountCount,
    derivedTradeAmountCount,
    kisVerifiedCount,
    kisErrorCount,
    duplicateStockCount,
    validationStatusCounts,
    method: KIS_ENABLED
      ? "KIS REST quote overlay + Naver header-aligned parser fallback"
      : "header-aligned parser + candidate-column validation + price-volume fallback",
    invariant: "Displayed sectors and stocks are sorted by validated daily trading value in descending order.",
    thresholds: {
      minRatio: TRADE_VALUE_MIN_RATIO,
      maxRatio: TRADE_VALUE_MAX_RATIO
    }
  };
}

async function buildMarketSnapshot(force = false) {
  if (!force && marketCache.data && marketCache.expiresAt > Date.now()) return marketCache.data;
  if (!force && marketCache.promise) return marketCache.promise;

  const promise = fetchHtml("/sise/sise_group.naver?type=upjong")
    .then(parseSectorList)
    .then(async (sectors) => {
      const [details, overview] = await Promise.all([
        mapLimit(sectors, DETAIL_CONCURRENCY, async (sector) => {
          try {
            return await getSectorDetail(sector, { force, kisStockLimit: 0 });
          } catch (error) {
            return {
              ...sector,
              tradingValueMillion: 0,
              volume: 0,
              weightedChangeRate: sector.changeRate,
              stocks: [],
              topStocks: [],
              topTradingValueStocks: [],
              topVolumeStocks: [],
              excludedEtfEtnCount: 0,
              repairedTradeAmountCount: 0,
              derivedTradeAmountCount: 0,
              unverifiedTradeAmountCount: 1,
              kisVerifiedCount: 0,
              kisErrorCount: 0,
              validationStatusCounts: { unverified: 1 },
              validation: { status: "error", error: error.message },
              error: error.message
            };
          }
        }),
        buildMarketOverview(force)
      ]);

      const naverRankedSectors = sortSectorsByTradingValue(details).map((sector, index) => ({
        ...sector,
        rank: index + 1
      }));
      const rankedSectors = await enrichRankedSectorsWithKis(naverRankedSectors, force);
      const validation = buildSnapshotValidation(rankedSectors);

      const totals = rankedSectors.reduce(
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
          acc.breadth.rising += sector.risingCount || 0;
          acc.breadth.flat += sector.flatCount || 0;
          acc.breadth.falling += sector.fallingCount || 0;
          return acc;
        },
        {
          tradingValueMillion: 0,
          volume: 0,
          stockCount: 0,
          sectorCount: rankedSectors.length,
          excludedEtfEtnCount: 0,
          repairedTradeAmountCount: 0,
          derivedTradeAmountCount: 0,
          unverifiedTradeAmountCount: 0,
          kisVerifiedCount: 0,
          kisErrorCount: 0,
          breadth: { rising: 0, flat: 0, falling: 0 }
        }
      );

      return {
        mode: "localhost-live",
        provider: KIS_ENABLED ? "KIS Open API + Naver Finance" : "Naver Finance",
        overviewProvider: "Yahoo Finance",
        rankingBasis: KIS_ENABLED ? "kis-verified-daily-trading-value" : "validated-daily-trading-value",
        validationMethod: validation.method,
        excludes: ["ETF", "ETN", "ELW"],
        refreshMs: STREAM_PUSH_MS,
        marketCacheMs: MARKET_CACHE_MS,
        overviewCacheMs: OVERVIEW_CACHE_MS,
        updatedAt: new Date().toISOString(),
        kis: getKisStatus(),
        overview,
        totals,
        validation,
        sectors: rankedSectors
      };
    });

  marketCache.promise = promise;

  try {
    const data = await promise;
    marketCache.data = data;
    marketCache.expiresAt = Date.now() + MARKET_CACHE_MS;
    return data;
  } finally {
    marketCache.promise = null;
  }
}

function buildVolumeProfile(stocks, limit = VOLUME_HISTORY_LIMIT) {
  const filtered = (stocks || []).filter((stock) => !isEtfOrEtnStock(stock));
  const items = filtered.slice(0, limit).map((stock) => ({
    code: stock.code,
    name: stock.name,
    day: stock.volume || 0,
    week: stock.periodVolumes?.week ?? null,
    month: stock.periodVolumes?.month ?? null
  }));

  return {
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
    provider: KIS_ENABLED ? "KIS Open API + Naver Finance" : "Naver Finance",
    overviewProvider: "Yahoo Finance",
    mode: "localhost-live",
    rankingBasis: KIS_ENABLED ? "kis-verified-daily-trading-value" : "validated-daily-trading-value",
    validationMethod: KIS_ENABLED
      ? "KIS REST quote overlay + Naver header-aligned parser fallback"
      : "header-aligned parser + candidate-column validation + price-volume fallback",
    excludes: ["ETF", "ETN", "ELW"],
    refreshMs: STREAM_PUSH_MS,
    marketCacheMs: MARKET_CACHE_MS,
    overviewCacheMs: OVERVIEW_CACHE_MS,
    tradeValueRatioThresholds: {
      min: TRADE_VALUE_MIN_RATIO,
      max: TRADE_VALUE_MAX_RATIO
    },
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
    response.json(await buildMarketOverview(request.query.force === "1"));
  } catch (error) {
    response.status(502).json({ error: error.message });
  }
});

app.get("/api/sectors", async (request, response) => {
  try {
    response.json(await buildMarketSnapshot(request.query.force === "1"));
  } catch (error) {
    response.status(502).json({ error: error.message });
  }
});

app.get("/api/validation", async (request, response) => {
  try {
    const snapshot = await buildMarketSnapshot(request.query.force === "1");
    response.status(snapshot.validation.status === "ok" ? 200 : 409).json(snapshot.validation);
  } catch (error) {
    response.status(502).json({ status: "error", error: error.message });
  }
});

app.get("/api/sectors/:id", async (request, response) => {
  try {
    const snapshot = await buildMarketSnapshot(false);
    const sector = snapshot.sectors.find((item) => item.id === request.params.id);
    if (!sector) return response.status(404).json({ error: "Sector not found" });
    response.json(
      await getSectorDetail(sector, {
        force: request.query.force === "1",
        kisStockLimit: KIS_SELECTED_SECTOR_STOCKS
      })
    );
  } catch (error) {
    response.status(502).json({ error: error.message });
  }
});

app.post("/api/volume-profile", (request, response) => {
  response.json(buildVolumeProfile(request.body?.stocks || [], Number(request.body?.limit || VOLUME_HISTORY_LIMIT)));
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
      const snapshot = await buildMarketSnapshot(false);
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

function startServer() {
  app.listen(PORT, () => {
    console.log(`Moneyboard live server listening on http://localhost:${PORT}`);
    console.log(`Provider: ${KIS_ENABLED ? "KIS Open API + Naver Finance fallback" : "Naver Finance only. KIS is disabled."}`);
    console.log(`KIS status: ${JSON.stringify(getKisStatus())}`);
    console.log("Ranking basis: validated daily trading value. ETF/ETN/ELW excluded.");
    console.log(`Validation: ${KIS_ENABLED ? "KIS quote overlay + Naver fallback" : "header-aligned parser + candidate-column validation + price-volume fallback"}.`);
    console.log(`Stream push: ${STREAM_PUSH_MS}ms, market cache: ${MARKET_CACHE_MS}ms, overview cache: ${OVERVIEW_CACHE_MS}ms.`);
    console.log("Market overview: KOSPI/KOSDAQ/Nasdaq100 futures/USD-KRW/S&P500 via Yahoo Finance.");
  });
}

const isCliEntry = process.argv[1] ? path.resolve(process.argv[1]) === __filename : false;
if (isCliEntry) startServer();

export {
  app,
  buildMarketSnapshot as getMarketSnapshot,
  buildMarketOverview as getMarketOverview,
  getSectorDetail,
  parseSectorList,
  parseSectorDetail,
  normalizeTradingValue,
  sortSectorsByTradingValue,
  sortStocksByTradingValue,
  buildSnapshotValidation
};
