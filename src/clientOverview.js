import { useEffect, useState } from "react";

const OVERVIEW_CACHE_MS = 5_000;
const REQUEST_TIMEOUT_MS = 8_000;

const OVERVIEW_INSTRUMENTS = [
  { id: "kospi", label: "코스피", symbol: "^KS11", provider: "Yahoo Finance" },
  { id: "kosdaq", label: "코스닥", symbol: "^KQ11", provider: "Yahoo Finance" },
  { id: "nasdaq100-futures", label: "나스닥100 선물", symbol: "NQ=F", provider: "Yahoo Finance" },
  { id: "usd-krw", label: "달러 환율", symbol: "KRW=X", provider: "Yahoo Finance", kind: "fx" },
  { id: "sp500", label: "S&P500", symbol: "^GSPC", provider: "Yahoo Finance" }
];

function yahooChartUrl(symbol) {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=5d&interval=30m&includePrePost=true`;
}

async function fetchYahooChart(symbol) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(yahooChartUrl(symbol), {
      signal: controller.signal,
      headers: {
        accept: "application/json,text/plain,*/*"
      }
    });
    if (!response.ok) throw new Error(`Yahoo Finance HTTP ${response.status}`);
    return response.json();
  } finally {
    window.clearTimeout(timeout);
  }
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
  const json = await fetchYahooChart(instrument.symbol);
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

async function loadClientMarketOverview() {
  const results = await Promise.allSettled(OVERVIEW_INSTRUMENTS.map(fetchOverviewInstrument));

  return {
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
  };
}

export function useClientMarketOverview(serverOverview) {
  const [overview, setOverview] = useState(null);

  useEffect(() => {
    if (serverOverview?.items?.length) {
      setOverview(null);
      return undefined;
    }

    let cancelled = false;
    let timer;

    const run = async () => {
      try {
        const data = await loadClientMarketOverview();
        if (!cancelled) setOverview(data);
      } catch {
        if (!cancelled) setOverview(null);
      } finally {
        if (!cancelled) timer = window.setTimeout(run, OVERVIEW_CACHE_MS);
      }
    };

    void run();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [serverOverview]);

  return serverOverview?.items?.length ? serverOverview : overview;
}
