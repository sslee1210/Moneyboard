const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 12_000);
export const OVERVIEW_CACHE_MS = Number(process.env.OVERVIEW_CACHE_MS || 5_000);

const overviewCache = { data: null, expiresAt: 0, promise: null };

const OVERVIEW_INSTRUMENTS = [
  { id: "kospi", label: "코스피", symbol: "^KS11", provider: "Yahoo Finance" },
  { id: "kosdaq", label: "코스닥", symbol: "^KQ11", provider: "Yahoo Finance" },
  { id: "nasdaq100-futures", label: "나스닥100 선물", symbol: "NQ=F", provider: "Yahoo Finance" },
  { id: "usd-krw", label: "달러 환율", symbol: "KRW=X", provider: "Yahoo Finance", kind: "fx" },
  { id: "sp500", label: "S&P500", symbol: "^GSPC", provider: "Yahoo Finance" }
];

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

export async function buildMarketOverview(force = false) {
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
