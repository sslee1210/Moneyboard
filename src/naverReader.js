const NAVER_BASE_URL = "https://finance.naver.com";
const READER_BASE_URL = "https://r.jina.ai/http://finance.naver.com";
const REQUEST_TIMEOUT_MS = 25_000;
const DETAIL_CACHE_MS = 25_000;
const MARKET_CACHE_MS = 60_000;
const DETAIL_CONCURRENCY = 8;

const detailCache = new Map();
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
      const details = await mapLimit(sectors, DETAIL_CONCURRENCY, (sector) => loadReaderSector(sector.id, sector));
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
