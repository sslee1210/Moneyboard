const NAVER_BASE_URL = "https://finance.naver.com";
const READER_BASE_URL = "https://r.jina.ai/http://finance.naver.com";
const READER_API_BASE_URL = "https://r.jina.ai/http://api.finance.naver.com";
const REQUEST_TIMEOUT_MS = 25_000;
const DETAIL_CACHE_MS = 25_000;
const MARKET_CACHE_MS = 60_000;
const HISTORY_CACHE_MS = 120_000;
const DETAIL_CONCURRENCY = 4;
const HISTORY_CONCURRENCY = 2;
const HISTORY_STOCK_LIMIT = 12;

const detailCache = new Map();
const historyCache = new Map();
const volumeProfileCache = new Map();
const marketCache = {
  data: null,
  expiresAt: 0,
  promise: null
};

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
  return Number(normalized);
}

function splitRow(row) {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function readerUrl(pathname) {
  const separator = pathname.includes("?") ? "&" : "?";
  return `${READER_BASE_URL}${pathname}${separator}t=${Date.now()}`;
}

function readerApiUrl(pathname) {
  const separator = pathname.includes("?") ? "&" : "?";
  return `${READER_API_BASE_URL}${pathname}${separator}t=${Date.now()}`;
}

async function fetchReaderText(pathname) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(readerUrl(pathname), {
      signal: controller.signal,
      headers: {
        accept: "text/plain, text/markdown"
      }
    });

    if (!response.ok) {
      throw new Error(`Reader responded with ${response.status}`);
    }

    return response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchReaderApiText(pathname) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(readerApiUrl(pathname), {
      signal: controller.signal,
      headers: {
        accept: "text/plain, text/markdown"
      }
    });

    if (!response.ok) {
      throw new Error(`Reader API responded with ${response.status}`);
    }

    return response.text();
  } finally {
    clearTimeout(timeout);
  }
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

function parseSiseJsonRows(text) {
  const rows = [];
  const rowPattern =
    /\["(\d{8})",\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\]/g;
  let match;

  while ((match = rowPattern.exec(text))) {
    rows.push({
      date: match[1],
      open: Number(match[2]),
      high: Number(match[3]),
      low: Number(match[4]),
      close: Number(match[5]),
      volume: Number(match[6]),
      foreignRate: Number(match[7])
    });
  }

  return rows;
}

function parseSectorList(markdown) {
  const sectors = [];
  const seen = new Set();

  markdown
    .split(/\r?\n/)
    .filter((line) => line.includes("sise_group_detail.naver?type=upjong&no="))
    .forEach((line) => {
      const rawCells = splitRow(line);
      const match = rawCells[0]?.match(
        /\[([^\]]+)\]\(https?:\/\/finance\.naver\.com\/sise\/sise_group_detail\.naver\?type=upjong&no=(\d+)\)/
      );

      if (!match || rawCells.length < 6 || seen.has(match[2])) return;
      seen.add(match[2]);

      sectors.push({
        id: match[2],
        name: compactText(match[1]),
        changeRate: parseNumber(rawCells[1]),
        stockCount: parseNumber(rawCells[2]),
        risingCount: parseNumber(rawCells[3]),
        flatCount: parseNumber(rawCells[4]),
        fallingCount: parseNumber(rawCells[5]),
        naverUrl: `${NAVER_BASE_URL}/sise/sise_group_detail.naver?type=upjong&no=${match[2]}`
      });
    });

  return sectors;
}

function parseStockRows(markdown) {
  const stocks = [];
  const seen = new Set();

  markdown
    .split(/\r?\n/)
    .filter((line) => line.includes("/item/main.naver?code=") && line.includes("|"))
    .forEach((line) => {
      const rawCells = splitRow(line);
      const match = rawCells[0]?.match(/\[([^\]]+)\]\(https?:\/\/finance\.naver\.com\/item\/main\.naver\?code=([A-Z0-9]+)\)(\*)?/);

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
        naverUrl: `${NAVER_BASE_URL}/item/main.naver?code=${match[2]}`
      });
    });

  stocks.sort((left, right) => right.tradeAmountMillion - left.tradeAmountMillion);
  return stocks;
}

function buildSectorDetail(sector, markdown) {
  const stocks = parseStockRows(markdown);
  const tradingValueMillion = stocks.reduce((sum, stock) => sum + stock.tradeAmountMillion, 0);
  const volume = stocks.reduce((sum, stock) => sum + stock.volume, 0);
  const weightedChangeRate =
    tradingValueMillion > 0
      ? stocks.reduce((sum, stock) => sum + stock.changeRate * stock.tradeAmountMillion, 0) / tradingValueMillion
      : sector.changeRate || 0;

  return {
    ...sector,
    tradingValueMillion,
    volume,
    weightedChangeRate,
    topStocks: stocks.slice(0, 8),
    stocks,
    fetchedAt: new Date().toISOString()
  };
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

function emptyDetail(sector, error) {
  return {
    ...sector,
    tradingValueMillion: 0,
    volume: 0,
    weightedChangeRate: sector.changeRate || 0,
    topStocks: [],
    stocks: [],
    fetchedAt: new Date().toISOString(),
    error: error.message
  };
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

export async function loadReaderSector(id, seedSector = {}, force = false) {
  const cached = detailCache.get(id);
  if (!force && cached?.data && cached.expiresAt > Date.now()) return cached.data;
  if (!force && cached?.promise) return cached.promise;

  const sector = {
    id,
    name: seedSector.name || "섹터",
    changeRate: seedSector.changeRate || 0,
    stockCount: seedSector.stockCount || 0,
    risingCount: seedSector.risingCount || 0,
    flatCount: seedSector.flatCount || 0,
    fallingCount: seedSector.fallingCount || 0,
    naverUrl: `${NAVER_BASE_URL}/sise/sise_group_detail.naver?type=upjong&no=${id}`,
    ...seedSector
  };

  const promise = fetchReaderText(`/sise/sise_group_detail.naver?type=upjong&no=${id}`)
    .then((markdown) => buildSectorDetail(sector, markdown))
    .then((data) => {
      detailCache.set(id, {
        data,
        expiresAt: Date.now() + DETAIL_CACHE_MS,
        promise: null
      });
      return data;
    })
    .catch((error) => {
      const fallback = cached?.data || emptyDetail(sector, error);
      detailCache.set(id, {
        data: fallback,
        expiresAt: Date.now() + Math.min(DETAIL_CACHE_MS, 10_000),
        promise: null
      });
      return fallback;
    });

  detailCache.set(id, {
    data: cached?.data,
    expiresAt: cached?.expiresAt || 0,
    promise
  });

  return promise;
}

export async function loadReaderMarket(force = false) {
  if (!force && marketCache.data && marketCache.expiresAt > Date.now()) return marketCache.data;
  if (!force && marketCache.promise) return marketCache.promise;

  marketCache.promise = fetchReaderText("/sise/sise_group.naver?type=upjong")
    .then(parseSectorList)
    .then(async (sectors) => {
      const details = await mapLimit(sectors, DETAIL_CONCURRENCY, (sector) => loadReaderSector(sector.id, sector, force));
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
        mode: "pages-reader-live",
        source: {
          name: "Naver Finance via r.jina.ai",
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
    })
    .then((data) => {
      marketCache.data = data;
      marketCache.expiresAt = Date.now() + MARKET_CACHE_MS;
      marketCache.promise = null;
      return data;
    })
    .catch((error) => {
      marketCache.promise = null;
      if (marketCache.data) {
        return {
          ...marketCache.data,
          stale: true,
          error: error.message
        };
      }
      throw error;
    });

  return marketCache.promise;
}

async function loadStockHistory(code, timeframe, force = false) {
  const cacheKey = `${code}:${timeframe}`;
  const cached = historyCache.get(cacheKey);

  if (!force && cached?.data && cached.expiresAt > Date.now()) return cached.data;
  if (!force && cached?.promise) return cached.promise;

  const endDate = new Date();
  const lookbackDays = timeframe === "month" ? 420 : timeframe === "week" ? 100 : 70;
  const startDate = addDays(endDate, -lookbackDays);
  const path = `/siseJson.naver?symbol=${code}&requestType=1&startTime=${formatDateParam(
    startDate
  )}&endTime=${formatDateParam(endDate)}&timeframe=${timeframe}`;

  const promise = fetchReaderApiText(path)
    .then(parseSiseJsonRows)
    .then((rows) => {
      const last = rows.at(-1) || null;
      const data = {
        code,
        timeframe,
        date: last?.date || null,
        volume: last?.volume || 0,
        close: last?.close || 0,
        rows
      };

      historyCache.set(cacheKey, {
        data,
        expiresAt: Date.now() + HISTORY_CACHE_MS,
        promise: null
      });

      return data;
    })
    .catch((error) => {
      const data = cached?.data || {
        code,
        timeframe,
        date: null,
        volume: 0,
        close: 0,
        rows: [],
        error: error.message
      };

      historyCache.set(cacheKey, {
        data,
        expiresAt: Date.now() + Math.min(HISTORY_CACHE_MS, 30_000),
        promise: null
      });

      return data;
    });

  historyCache.set(cacheKey, {
    data: cached?.data,
    expiresAt: cached?.expiresAt || 0,
    promise
  });

  return promise;
}

export async function loadReaderVolumeProfile(stocks, { force = false, limit = HISTORY_STOCK_LIMIT } = {}) {
  const sample = (stocks || []).slice(0, limit);
  const cacheKey = sample.map((stock) => stock.code).join(",");
  const cached = volumeProfileCache.get(cacheKey);

  if (!sample.length) {
    return {
      sampleSize: 0,
      limit,
      byCode: {},
      totals: {
        day: 0,
        week: 0,
        month: 0
      },
      updatedAt: new Date().toISOString()
    };
  }

  if (!force && cached?.data && cached.expiresAt > Date.now()) return cached.data;
  if (!force && cached?.promise) return cached.promise;

  const promise = mapLimit(sample, HISTORY_CONCURRENCY, async (stock) => {
    const history = await loadStockHistory(stock.code, "day", force);
    const rows = history.rows || [];
    const sumRecentVolume = (count) => rows.slice(-count).reduce((sum, row) => sum + row.volume, 0);
    const hasHistory = rows.length > 0 && !history.error;

    return {
      code: stock.code,
      name: stock.name,
      day: stock.volume || history.volume || 0,
      week: hasHistory ? sumRecentVolume(5) : null,
      month: hasHistory ? sumRecentVolume(20) : null,
      weekDate: history.date,
      monthDate: history.date,
      error: history.error || null
    };
  })
    .then((items) => {
      const byCode = Object.fromEntries(items.map((item) => [item.code, item]));
      const data = {
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
        updatedAt: new Date().toISOString()
      };

      volumeProfileCache.set(cacheKey, {
        data,
        expiresAt: Date.now() + HISTORY_CACHE_MS,
        promise: null
      });

      return data;
    })
    .catch((error) => {
      const data = cached?.data || {
        sampleSize: sample.length,
        limit,
        byCode: {},
        totals: {
          day: 0,
          week: 0,
          month: 0
        },
        counts: {
          day: 0,
          week: 0,
          month: 0
        },
        updatedAt: new Date().toISOString(),
        error: error.message
      };

      volumeProfileCache.set(cacheKey, {
        data,
        expiresAt: Date.now() + Math.min(HISTORY_CACHE_MS, 30_000),
        promise: null
      });

      return data;
    });

  volumeProfileCache.set(cacheKey, {
    data: cached?.data,
    expiresAt: cached?.expiresAt || 0,
    promise
  });

  return promise;
}
