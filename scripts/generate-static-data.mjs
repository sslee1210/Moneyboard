import { mkdir, writeFile } from "node:fs/promises";
import { getMarketSnapshot, getSectorDetail } from "../server.js";

const outDir = new URL("../public/data/", import.meta.url);
const sectorDir = new URL("./sectors/", outDir);
const HISTORY_LIMIT = 12;
const HISTORY_CONCURRENCY = 8;

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
      close: Number(match[5]),
      volume: Number(match[6])
    });
  }

  return rows;
}

async function fetchPeriodVolumes(stock) {
  const endDate = new Date();
  const startDate = addDays(endDate, -70);
  const url = new URL("https://api.finance.naver.com/siseJson.naver");
  url.searchParams.set("symbol", stock.code);
  url.searchParams.set("requestType", "1");
  url.searchParams.set("startTime", formatDateParam(startDate));
  url.searchParams.set("endTime", formatDateParam(endDate));
  url.searchParams.set("timeframe", "day");

  try {
    const response = await fetch(url, {
      headers: {
        "accept": "application/json,text/plain,*/*",
        "referer": `https://finance.naver.com/item/sise_day.naver?code=${stock.code}`,
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
      }
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const rows = parseSiseJsonRows(await response.text());
    if (!rows.length) throw new Error("No history rows");

    return {
      code: stock.code,
      day: stock.volume || rows.at(-1)?.volume || 0,
      week: rows.slice(-5).reduce((sum, row) => sum + row.volume, 0),
      month: rows.slice(-20).reduce((sum, row) => sum + row.volume, 0),
      date: rows.at(-1)?.date || null
    };
  } catch (error) {
    return {
      code: stock.code,
      day: stock.volume || 0,
      week: null,
      month: null,
      date: null,
      error: error.message
    };
  }
}

async function addPeriodVolumes(detail) {
  const sample = detail.stocks.slice(0, HISTORY_LIMIT);
  const histories = await mapLimit(sample, HISTORY_CONCURRENCY, fetchPeriodVolumes);
  const byCode = new Map(histories.map((history) => [history.code, history]));

  const annotate = (stock) => {
    const periodVolumes = byCode.get(stock.code);
    return periodVolumes ? { ...stock, periodVolumes } : stock;
  };

  return {
    ...detail,
    topStocks: detail.topStocks.map(annotate),
    stocks: detail.stocks.map(annotate)
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

await mkdir(sectorDir, { recursive: true });

const snapshot = await getMarketSnapshot();
const details = await mapLimit(snapshot.sectors, 8, async (sector) => addPeriodVolumes(await getSectorDetail(sector)));

await writeFile(
  new URL("./market.json", outDir),
  JSON.stringify(
    {
      ...snapshot,
      mode: "static-pages-snapshot",
      generatedAt: new Date().toISOString()
    },
    null,
    2
  )
);

await Promise.all(
  details.map((detail) =>
    writeFile(new URL(`./sectors/${detail.id}.json`, outDir), JSON.stringify(detail, null, 2))
  )
);

console.log(`Generated static Pages data for ${snapshot.sectors.length} sectors.`);
