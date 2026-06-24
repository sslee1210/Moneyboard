import { Activity, BarChart3, Clock3, Database, LineChart, Radio, Search, TrendingUp } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { loadReaderMarket, loadReaderSector, loadReaderVolumeProfile } from "./naverReader";

const currencyFormatter = new Intl.NumberFormat("ko-KR");
const percentFormatter = new Intl.NumberFormat("ko-KR", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2
});
const staticDataBase = import.meta.env.BASE_URL || "/";
const configuredApiBase = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
const canUseSameOriginApi =
  typeof window !== "undefined" && ["4173", "8787"].includes(window.location.port) && !window.location.hostname.endsWith("github.io");
const canUseApi = Boolean(configuredApiBase || canUseSameOriginApi);
const apiFallbackPollMs = 30_000;
const pagesLiveSuccessDelayMs = 0;
const pagesLiveFailureRetryMs = 15_000;
const volumePeriods = [
  { id: "day", label: "일일" },
  { id: "week", label: "주간" },
  { id: "month", label: "월간" }
];
const volumePeriodLabels = Object.fromEntries(volumePeriods.map((period) => [period.id, period.label]));
const volumeHistoryLimit = 12;
const flowAlertThresholdMillion = 1_000;
const flowAlertWindows = [
  { id: "1m", label: "1분봉", durationMs: 60_000 },
  { id: "3m", label: "3분봉", durationMs: 180_000 }
];
const flowAlertCooldownMs = 180_000;
const flowAlertHistoryMs = 180_000;
const flowAlertLimit = 30;

function apiUrl(path) {
  return configuredApiBase ? `${configuredApiBase}${path}` : path;
}

function staticDataUrl(path) {
  return `${staticDataBase}${path}`.replace(/\/{2,}/g, "/");
}

async function fetchJson(url) {
  const separator = url.includes("?") ? "&" : "?";
  const response = await fetch(`${url}${separator}t=${Date.now()}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function loadStaticMarket() {
  return fetchJson(staticDataUrl("data/market.json"));
}

function loadStaticSector(id) {
  return fetchJson(staticDataUrl(`data/sectors/${id}.json`));
}

async function loadLiveMarket({ forceReader = false } = {}) {
  let apiError = null;

  if (canUseApi) {
    try {
      return await fetchJson(apiUrl("/api/sectors"));
    } catch (error) {
      apiError = error;
    }
  }

  try {
    return await loadReaderMarket(forceReader);
  } catch (readerError) {
    throw apiError || readerError;
  }
}

async function loadLiveSector(sector, { forceReader = false } = {}) {
  let apiError = null;

  if (canUseApi) {
    try {
      return await fetchJson(apiUrl(`/api/sectors/${sector.id}`));
    } catch (error) {
      apiError = error;
    }
  }

  try {
    const data = await loadReaderSector(sector.id, sector, forceReader);
    if ((data?.error || sector.stockCount > 0) && !data?.stocks?.length) {
      throw new Error(data?.error || "Empty sector detail");
    }
    return data;
  } catch (readerError) {
    throw apiError || readerError;
  }
}

async function loadLiveVolumeProfile(stocks, { forceReader = false, limit = volumeHistoryLimit } = {}) {
  if (canUseApi) {
    try {
      return await postJson(apiUrl("/api/volume-profile"), {
        stocks: (stocks || []).slice(0, limit),
        limit
      });
    } catch {
      // Fall through to the client reader/static data path.
    }
  }

  return loadReaderVolumeProfile(stocks, {
    force: forceReader,
    limit
  });
}

function formatTradingValue(millionWon = 0) {
  const value = Number(millionWon) || 0;
  if (value >= 100_000) {
    return `${percentFormatter.format(value / 100_000)}조`;
  }
  if (value >= 100) {
    return `${percentFormatter.format(value / 100)}억`;
  }
  return `${currencyFormatter.format(Math.round(value))}백만`;
}

function formatNumber(value = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "-";
  return currencyFormatter.format(Math.round(number));
}

function formatVolume(value) {
  if (value === null || value === undefined) return "-";
  const rounded = Math.round(value);
  if (rounded >= 100_000_000) {
    return `${percentFormatter.format(rounded / 100_000_000)}억주`;
  }
  if (rounded >= 10_000) {
    return `${percentFormatter.format(rounded / 10_000)}만주`;
  }
  return `${currencyFormatter.format(rounded)}주`;
}

function formatPercent(value = 0) {
  const number = Number.isFinite(Number(value)) ? Number(value) : 0;
  const sign = number > 0 ? "+" : "";
  return `${sign}${percentFormatter.format(number)}%`;
}

function formatOverviewValue(item) {
  const value = Number(item?.value);
  if (!Number.isFinite(value)) return "수집 대기";
  if (item?.kind === "fx") return `${percentFormatter.format(value)}원`;
  return percentFormatter.format(value);
}

function formatTime(value) {
  if (!value) return "--:--:--";
  try {
    return new Intl.DateTimeFormat("ko-KR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(new Date(value));
  } catch {
    return "--:--:--";
  }
}

function overviewItems(overview) {
  const preferredOrder = ["kospi", "kosdaq", "nasdaq100-futures", "usd-krw", "sp500"];
  const items = overview?.items || [];
  const byId = new Map(items.map((item) => [item.id, item]));
  const ordered = preferredOrder.map((id) => byId.get(id)).filter(Boolean);
  return ordered.length ? ordered : items;
}

function sparklinePath(points, width = 180, height = 46, padding = 3) {
  const values = (points || []).map((point) => Number(point.value)).filter((value) => Number.isFinite(value));
  if (values.length < 2) return "";

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || Math.max(Math.abs(max) * 0.001, 1);

  return values
    .map((value, index) => {
      const x = padding + (index / Math.max(values.length - 1, 1)) * (width - padding * 2);
      const y = padding + (1 - (value - min) / range) * (height - padding * 2);
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function changeClass(value = 0) {
  const number = Number(value) || 0;
  if (number > 0) return "positive";
  if (number < 0) return "negative";
  return "neutral";
}

function normalizeSearchText(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[()\[\]{}·.,/_-]/g, "");
}

function stockSearchText(stock) {
  return normalizeSearchText(`${stock?.name || ""} ${stock?.code || ""} ${stock?.market || ""} ${stock?.sectorName || ""}`);
}

function sectorSearchText(sector) {
  const stockNames = (sector?.topStocks || []).map((stock) => `${stock.name} ${stock.code}`).join(" ");
  return normalizeSearchText(`${sector?.name || ""} ${stockNames}`);
}

function stockMatchesQuery(stock, normalizedQuery) {
  if (!normalizedQuery) return true;
  return stockSearchText(stock).includes(normalizedQuery);
}

function shortName(name = "") {
  return name.length > 8 ? `${name.slice(0, 8)}...` : name;
}

function compactTrackedStocks(snapshot) {
  const byCode = new Map();

  (snapshot?.sectors || []).forEach((sector, sectorIndex) => {
    (sector.topStocks || []).forEach((stock) => {
      if (!stock?.code) return;
      const tradeAmountMillion = Number(stock.tradeAmountMillion);
      if (!Number.isFinite(tradeAmountMillion)) return;

      const current = byCode.get(stock.code);
      const next = {
        code: stock.code,
        name: stock.name,
        market: stock.market,
        price: stock.price,
        changeRate: stock.changeRate,
        tradeAmountMillion,
        sectorName: sector.name,
        sectorRank: sector.rank || sectorIndex + 1,
        naverUrl: stock.naverUrl
      };

      if (!current || tradeAmountMillion > current.tradeAmountMillion) {
        byCode.set(stock.code, next);
      }
    });
  });

  return [...byCode.values()];
}

function buildFlowAlerts(snapshot, samplesByCode, cooldownBySignal, now) {
  const trackedStocks = compactTrackedStocks(snapshot);
  const maxWindowMs = Math.max(...flowAlertWindows.map((windowItem) => windowItem.durationMs));
  const nextAlerts = [];

  trackedStocks.forEach((stock) => {
    const currentValue = stock.tradeAmountMillion;
    const currentSamples = samplesByCode.get(stock.code) || [];
    const lastSample = currentSamples[currentSamples.length - 1];
    const resetSamples = lastSample && currentValue < lastSample.value;
    const nextSamples = resetSamples ? [] : currentSamples.filter((sample) => now - sample.ts <= maxWindowMs + 5_000);

    if (!lastSample || resetSamples || currentValue !== lastSample.value || now - lastSample.ts >= 1_500) {
      nextSamples.push({ ts: now, value: currentValue });
    }

    samplesByCode.set(stock.code, nextSamples);

    if (nextSamples.length < 2) return;

    flowAlertWindows.forEach((windowItem) => {
      const windowSamples = nextSamples.filter((sample) => now - sample.ts <= windowItem.durationMs);
      if (windowSamples.length < 2) return;

      const base = windowSamples[0];
      const elapsedMs = now - base.ts;
      const deltaMillion = currentValue - base.value;
      if (elapsedMs <= 0 || deltaMillion < flowAlertThresholdMillion) return;

      const signalKey = `${stock.code}:${windowItem.id}`;
      const lastAlertAt = cooldownBySignal.get(signalKey) || 0;
      if (now - lastAlertAt < flowAlertCooldownMs) return;

      cooldownBySignal.set(signalKey, now);
      nextAlerts.push({
        id: `${signalKey}:${now}`,
        code: stock.code,
        name: stock.name,
        market: stock.market,
        price: stock.price,
        changeRate: stock.changeRate,
        sectorName: stock.sectorName,
        sectorRank: stock.sectorRank,
        naverUrl: stock.naverUrl,
        windowLabel: windowItem.label,
        deltaMillion,
        elapsedSeconds: Math.max(1, Math.round(elapsedMs / 1000)),
        triggeredAt: new Date(now).toISOString()
      });
    });
  });

  const activeCodes = new Set(trackedStocks.map((stock) => stock.code));
  [...samplesByCode.keys()].forEach((code) => {
    if (!activeCodes.has(code)) samplesByCode.delete(code);
  });

  return nextAlerts.sort((left, right) => right.deltaMillion - left.deltaMillion);
}

function useFlowAlerts(snapshot) {
  const samplesByCodeRef = useRef(new Map());
  const cooldownBySignalRef = useRef(new Map());
  const [alerts, setAlerts] = useState([]);

  useEffect(() => {
    if (!snapshot?.sectors?.length) return;
    const now = Date.now();
    const nextAlerts = buildFlowAlerts(snapshot, samplesByCodeRef.current, cooldownBySignalRef.current, now);

    if (nextAlerts.length) {
      setAlerts((current) => {
        const freshCurrent = current.filter((alert) => now - new Date(alert.triggeredAt).getTime() <= flowAlertHistoryMs);
        return [...nextAlerts, ...freshCurrent].slice(0, flowAlertLimit);
      });
    } else {
      setAlerts((current) => current.filter((alert) => now - new Date(alert.triggeredAt).getTime() <= flowAlertHistoryMs));
    }
  }, [snapshot]);

  return alerts;
}

function useMarketStream() {
  const [snapshot, setSnapshot] = useState(null);
  const [streamState, setStreamState] = useState("connecting");
  const [error, setError] = useState("");

  useEffect(() => {
    let closed = false;
    let fallbackTimer;
    let fallbackLoopStarted = false;

    const loadPagesLiveSnapshot = async () => {
      try {
        const data = await loadLiveMarket({ forceReader: true });
        if (!closed) {
          setSnapshot(data);
          setStreamState("live");
          setError("");
        }
        return pagesLiveSuccessDelayMs;
      } catch (liveError) {
        try {
          const data = await loadStaticMarket();
          if (!closed) {
            setSnapshot((current) => current || data);
            setStreamState("polling");
            setError(`실시간 수집 재시도 중: ${liveError.message}`);
          }
        } catch (staticError) {
          if (!closed) {
            setStreamState("offline");
            setError(staticError.message || liveError.message);
          }
        }

        return pagesLiveFailureRetryMs;
      }
    };

    const loadStaticPreview = async () => {
      try {
        const data = await loadStaticMarket();
        if (!closed) {
          setSnapshot((current) => current || data);
          setStreamState((current) => (current === "connecting" ? "static" : current));
          setError("실시간 수집 준비 중");
        }
      } catch {
        // The live reader path will surface a useful error if both paths fail.
      }
    };

    const loadFallback = async ({ forceReader = false } = {}) => {
      try {
        const data = await loadLiveMarket({ forceReader });
        if (!closed) {
          setSnapshot(data);
          setStreamState("live");
          setError("");
        }
      } catch (apiError) {
        try {
          const data = await loadStaticMarket();
          if (!closed) {
            setSnapshot((current) => current || data);
            setStreamState("static");
            setError("정적 스냅샷");
          }
        } catch (staticError) {
          if (!closed) {
            setStreamState("offline");
            setError(staticError.message || apiError.message);
          }
        }
      }
    };

    const startFallbackLoop = ({ forceReader = false, delayMs = apiFallbackPollMs } = {}) => {
      if (fallbackLoopStarted) return;
      fallbackLoopStarted = true;

      const run = async () => {
        await loadFallback({ forceReader });
        if (!closed) {
          fallbackTimer = window.setTimeout(run, delayMs);
        }
      };

      void run();
    };

    if (!canUseApi) {
      loadStaticPreview();

      const run = async () => {
        const nextDelayMs = await loadPagesLiveSnapshot();
        if (!closed) {
          fallbackTimer = window.setTimeout(run, nextDelayMs);
        }
      };

      void run();
      return () => {
        closed = true;
        clearTimeout(fallbackTimer);
      };
    }

    if (!("EventSource" in window)) {
      loadStaticPreview();
      startFallbackLoop();
      return () => {
        closed = true;
        clearTimeout(fallbackTimer);
      };
    }

    const stream = new EventSource(apiUrl("/api/stream"));

    stream.addEventListener("open", () => {
      if (!closed) setStreamState("live");
    });

    stream.addEventListener("market", (event) => {
      if (!closed) {
        setSnapshot(JSON.parse(event.data));
        setStreamState("live");
        setError("");
      }
    });

    stream.addEventListener("error", () => {
      if (!closed) {
        setStreamState("polling");
        startFallbackLoop();
      }
    });

    return () => {
      closed = true;
      stream.close();
      clearTimeout(fallbackTimer);
    };
  }, []);

  return { snapshot, streamState, error };
}

function MarketOverviewStrip({ overview }) {
  const items = overviewItems(overview);
  if (!items.length) return null;

  return (
    <section className="market-overview-strip" aria-label="시장 주요 지표">
      {items.map((item) => {
        const changeRate = item.changeRate || 0;
        const points = item.points || [];
        const path = sparklinePath(points);
        const qualityLabel = item.dataQuality === "ok" ? `${item.pointCount || points.length}p` : "지연/부족";

        return (
          <article className={`market-overview-card ${changeClass(changeRate)}`} key={item.id || item.symbol || item.label}>
            <div className="market-overview-head">
              <span>{item.label}</span>
              <em>{item.symbol}</em>
            </div>
            <div className="market-overview-main">
              <strong>{formatOverviewValue(item)}</strong>
              <small className={changeClass(changeRate)}>{formatPercent(changeRate)}</small>
            </div>
            <svg className="market-sparkline" viewBox="0 0 180 46" preserveAspectRatio="none" role="img" aria-label={`${item.label} 미니 차트`}>
              <line x1="0" y1="23" x2="180" y2="23" />
              {path ? <path d={path} /> : null}
            </svg>
            <div className="market-overview-foot">
              <span>{item.provider || overview?.provider || "source"}</span>
              <span>{qualityLabel} · {formatTime(item.updatedAt || overview?.updatedAt)}</span>
            </div>
          </article>
        );
      })}
    </section>
  );
}

function MetricCard({ icon: Icon, label, value, detail, tone = "default" }) {
  return (
    <section className={`metric metric-${tone}`}>
      <div className="metric-icon">
        <Icon size={18} />
      </div>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
        <span>{detail}</span>
      </div>
    </section>
  );
}

function SectorCard({ sector, selected, maxValue, onSelect, query }) {
  const tradingValue = sector.tradingValueMillion || 0;
  const width = maxValue ? Math.max(4, (tradingValue / maxValue) * 100) : 0;
  const normalizedQuery = normalizeSearchText(query);
  const allTopStocks = sector.topStocks || [];
  const matchingStocks = normalizedQuery ? allTopStocks.filter((stock) => stockMatchesQuery(stock, normalizedQuery)) : [];
  const topStocks = (matchingStocks.length ? matchingStocks : allTopStocks).slice(0, 5);
  const sectorChange = sector.weightedChangeRate ?? sector.changeRate ?? 0;
  const searchHit = Boolean(normalizedQuery && matchingStocks.length);

  const handleKeyDown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(sector);
    }
  };

  return (
    <article
      className={`sector-card-block ${selected ? "is-selected" : ""} ${searchHit ? "is-search-hit" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(sector)}
      onKeyDown={handleKeyDown}
    >
      <div className="sector-card-head">
        <span className="sector-rank">{sector.rank}</span>
        <div className="sector-title-wrap">
          <strong>{sector.name}</strong>
          <small>{sector.stockCount}종목 · {searchHit ? "검색 종목 우선 표시" : sector.topStockName || topStocks[0]?.name || "집계 중"}</small>
        </div>
        <div className="sector-card-values">
          <strong>{formatTradingValue(sector.tradingValueMillion)}</strong>
          <span className={changeClass(sectorChange)}>{formatPercent(sectorChange)}</span>
        </div>
      </div>
      <i className="sector-card-bar" style={{ width: `${width}%` }} />
      <ol className="sector-stock-list" aria-label={`${sector.name} 상위 종목`}>
        {topStocks.length ? (
          topStocks.map((stock, index) => (
            <li className={stockMatchesQuery(stock, normalizedQuery) && normalizedQuery ? "is-match" : ""} key={stock.code || `${sector.id}-${stock.name}-${index}`}>
              <span className="stock-chip-rank">{index + 1}</span>
              <span className="stock-chip-name">{stock.name}</span>
              <span className={`stock-chip-change ${changeClass(stock.changeRate)}`}>{formatPercent(stock.changeRate)}</span>
              <span className="stock-chip-money">{formatTradingValue(stock.tradeAmountMillion)}</span>
            </li>
          ))
        ) : (
          <li className="is-empty">
            <span>종목 상세 수집 중</span>
          </li>
        )}
      </ol>
    </article>
  );
}

function FlowAlertPanel({ alerts, snapshot }) {
  const watchlist = snapshot?.precisionWatchlist || {};
  const candidates = watchlist.candidates || [];
  const selectedCount = watchlist.selectedCount || candidates.length || 0;
  const liveQuoteCount = Number(watchlist.liveQuoteCount || candidates.filter((candidate) => candidate.live).length || 0);
  const liveRatio = selectedCount ? Math.min(100, (liveQuoteCount / selectedCount) * 100) : 0;
  const provider = String(watchlist.precisionProvider || "").toLowerCase();
  const kiwoomLive = provider.includes("kiwoom") && liveQuoteCount > 0;
  const kiwoomConfigured = watchlist.adapter?.kiwoomBridge?.enabled || watchlist.adapter?.kiwoom?.enabled;
  const statusLabel = kiwoomLive
    ? `키움 실시간 연결 ${liveQuoteCount}/${selectedCount}`
    : kiwoomConfigured
      ? "키움 브릿지 대기"
      : "키움 연결 필요";

  const topCandidates = candidates.slice(0, 10);

  return (
    <aside className={`flow-alert-panel ${kiwoomLive ? "is-kiwoom-live" : "is-kiwoom-pending"}`} aria-label="실시간 정밀감시 패널">
      <div className="flow-alert-header">
        <div>
          <span className="eyebrow">실시간 알림</span>
          <h2>분봉 10억 유입</h2>
        </div>
        <strong>{alerts.length}</strong>
      </div>

      <div className="kiwoom-status-card">
        <div>
          <span className="kiwoom-status-label">{statusLabel}</span>
          <small>네이버 후보 선정 → 키움 실시간 체결값 반영</small>
        </div>
        <b>{Math.round(liveRatio)}%</b>
      </div>

      <p className="flow-alert-rule">1분봉 또는 3분봉 누적 거래대금 증가분이 10억 이상이면 표시</p>

      <section className="side-section">
        <div className="side-section-title">
          <span>종목별 감지 횟수</span>
          <small>현재 세션 · {new Set(alerts.map((alert) => alert.code)).size}종목</small>
        </div>
        <div className="flow-alert-list">
          {alerts.length ? (
            alerts.map((alert) => (
              <a className="flow-alert-item" key={alert.id} href={alert.naverUrl} target="_blank" rel="noreferrer">
                <div className="flow-alert-topline">
                  <span className="flow-alert-badge">{alert.windowLabel}</span>
                  <time>{formatTime(alert.triggeredAt)}</time>
                </div>
                <div className="flow-alert-name-row">
                  <strong>{alert.name}</strong>
                  <small>{alert.code} · {alert.market}</small>
                </div>
                <div className="flow-alert-meta">
                  <span>{alert.sectorRank}위 {alert.sectorName}</span>
                  <span className={changeClass(alert.changeRate)}>{formatPercent(alert.changeRate)}</span>
                </div>
                <div className="flow-alert-money">
                  <strong>+{formatTradingValue(alert.deltaMillion)}</strong>
                  <span>{alert.elapsedSeconds}초 누적</span>
                </div>
              </a>
            ))
          ) : (
            <div className="flow-alert-empty">
              <strong>감시 중</strong>
              <span>10억 이상 유입 종목이 발생하면 여기에 쌓입니다.</span>
            </div>
          )}
        </div>
      </section>

      <section className="side-section precision-watch-section">
        <div className="side-section-title">
          <span>정밀감시 후보</span>
          <small>{kiwoomLive ? "kiwoom LIVE" : "네이버 후보"}</small>
        </div>
        <div className="precision-candidate-list">
          {topCandidates.length ? (
            topCandidates.map((candidate) => (
              <a className={`precision-candidate ${candidate.live ? "is-live" : ""}`} key={candidate.code} href={candidate.naverUrl} target="_blank" rel="noreferrer">
                <span className="precision-rank">{candidate.watchRank}</span>
                <div className="precision-main">
                  <strong>{candidate.name}</strong>
                  <small>{candidate.code} · {candidate.market} · {candidate.sectorName}</small>
                </div>
                <div className="precision-values">
                  <strong>{formatTradingValue(candidate.tradeAmountMillion)}</strong>
                  <span className={changeClass(candidate.changeRate)}>{formatPercent(candidate.changeRate)}</span>
                </div>
              </a>
            ))
          ) : (
            <div className="flow-alert-empty">
              <strong>후보 대기</strong>
              <span>상위 후보가 계산되면 여기에 표시됩니다.</span>
            </div>
          )}
        </div>
      </section>
    </aside>
  );
}

function stockPeriodVolume(stock, volumeProfile, period) {
  if (period === "day") return stock.volume || 0;
  const periodData = volumeProfile?.byCode?.[stock.code];
  return periodData?.[period] ?? stock.periodVolumes?.[period] ?? null;
}

function buildStaticVolumeProfile(stocks) {
  const sample = (stocks || []).slice(0, volumeHistoryLimit);
  const items = sample
    .map((stock) => ({
      code: stock.code,
      name: stock.name,
      day: stock.periodVolumes?.day ?? stock.volume ?? 0,
      week: stock.periodVolumes?.week ?? null,
      month: stock.periodVolumes?.month ?? null,
      weekDate: stock.periodVolumes?.date ?? null,
      monthDate: stock.periodVolumes?.date ?? null
    }))
    .filter((item) => item.day || item.week || item.month);

  if (!items.length) return null;

  return {
    sampleSize: items.length,
    limit: volumeHistoryLimit,
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

function StockTable({ stocks, volumeProfile }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>종목</th>
            <th>현재가</th>
            <th>등락률</th>
            <th>일 거래량</th>
            <th>주간 거래량</th>
            <th>월간 거래량</th>
            <th>거래대금</th>
          </tr>
        </thead>
        <tbody>
          {stocks.map((stock) => {
            const periodData = volumeProfile?.byCode?.[stock.code] || stock.periodVolumes;

            return (
              <tr key={stock.code}>
                <td>
                  <a href={stock.naverUrl} target="_blank" rel="noreferrer">
                    {stock.name}
                  </a>
                  <span>{stock.code} · {stock.market}{stock.live ? " · kiwoom LIVE" : ""}</span>
                </td>
                <td>{formatNumber(stock.price)}</td>
                <td className={changeClass(stock.changeRate)}>{formatPercent(stock.changeRate)}</td>
                <td>{formatVolume(stock.volume)}</td>
                <td>{formatVolume(periodData?.week)}</td>
                <td>{formatVolume(periodData?.month)}</td>
                <td>{formatTradingValue(stock.tradeAmountMillion)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SectorDetail({
  sector,
  detail,
  loading,
  volumePeriod,
  onVolumePeriodChange,
  volumeProfile,
  volumeLoading,
  query
}) {
  const normalizedQuery = normalizeSearchText(query);
  const rawStocks = detail?.stocks || sector?.topStocks || [];
  const stocks = normalizedQuery
    ? rawStocks.filter((stock) => stockMatchesQuery({ ...stock, sectorName: sector?.name }, normalizedQuery))
    : rawStocks;
  const displayStocks = stocks.length ? stocks : rawStocks;
  const periodLabel = volumePeriodLabels[volumePeriod] || "일일";
  const sampleSize = volumeProfile?.sampleSize || Math.min(displayStocks.length, volumeHistoryLimit);
  const hasSelectedVolume = displayStocks.length > 0 && (volumePeriod === "day" || (volumeProfile?.counts?.[volumePeriod] || 0) > 0);
  const selectedVolumeTotal =
    volumeProfile?.totals?.[volumePeriod] ??
    displayStocks.slice(0, sampleSize).reduce((sum, stock) => sum + (stockPeriodVolume(stock, volumeProfile, volumePeriod) || 0), 0);
  const chartData = displayStocks
    .map((stock) => ({
      name: shortName(stock.name),
      거래량: stockPeriodVolume(stock, volumeProfile, volumePeriod) || 0,
      등락률: Number((stock.changeRate || 0).toFixed(2))
    }))
    .filter((stock) => stock.거래량 > 0)
    .sort((left, right) => right.거래량 - left.거래량)
    .slice(0, 12);

  return (
    <section className="detail-panel">
      <div className="panel-header">
        <div>
          <span className="eyebrow">선택 섹터</span>
          <h2>{sector?.name || "섹터 선택"}</h2>
        </div>
        <div className="detail-actions">
          <div className="period-toggle" role="tablist" aria-label="거래량 기간">
            {volumePeriods.map((period) => (
              <button
                key={period.id}
                className={period.id === volumePeriod ? "is-active" : ""}
                type="button"
                onClick={() => onVolumePeriodChange(period.id)}
              >
                {period.label}
              </button>
            ))}
          </div>
          <div className={`status-dot ${loading || volumeLoading ? "loading" : "live"}`}>
            <span />
            {loading || volumeLoading ? "갱신 중" : "동기화"}
          </div>
        </div>
      </div>

      <div className="detail-stats">
        <div>
          <span>거래대금</span>
          <strong>{formatTradingValue(detail?.tradingValueMillion || sector?.tradingValueMillion)}</strong>
        </div>
        <div>
          <span>{periodLabel} 거래량</span>
          <strong>{volumeLoading ? "수집 중" : hasSelectedVolume ? formatVolume(selectedVolumeTotal) : "-"}</strong>
          <small>상위 {sampleSize}종목 기준</small>
        </div>
        <div>
          <span>가중 등락률</span>
          <strong className={changeClass(detail?.weightedChangeRate || sector?.weightedChangeRate)}>
            {formatPercent(detail?.weightedChangeRate || sector?.weightedChangeRate)}
          </strong>
        </div>
        <div>
          <span>상승/하락</span>
          <strong>{sector?.risingCount || 0}/{sector?.fallingCount || 0}</strong>
        </div>
      </div>

      <div className="chart-card detail-chart">
        <div className="chart-title">
          <LineChart size={18} />
          <span>{periodLabel} 거래량 상위 종목</span>
        </div>
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={chartData} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#e7e9ef" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} />
            <YAxis yAxisId="left" tick={{ fontSize: 11 }} tickFormatter={formatVolume} width={72} />
            <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} tickFormatter={(value) => `${value}%`} />
            <Tooltip formatter={(value, name) => (name === "거래량" ? formatVolume(value) : `${value}%`)} />
            <Bar yAxisId="left" dataKey="거래량" radius={[4, 4, 0, 0]} fill="#2f7d68" />
            <Line yAxisId="right" type="monotone" dataKey="등락률" stroke="#d65a31" strokeWidth={2} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <StockTable stocks={displayStocks} volumeProfile={volumeProfile} />
    </section>
  );
}

export default function App() {
  const { snapshot, streamState, error } = useMarketStream();
  const flowAlerts = useFlowAlerts(snapshot);
  const [selectedId, setSelectedId] = useState("");
  const [manualSelection, setManualSelection] = useState(false);
  const [query, setQuery] = useState("");
  const [sectorDetail, setSectorDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [volumePeriod, setVolumePeriod] = useState("day");
  const [volumeProfile, setVolumeProfile] = useState(null);
  const [volumeLoading, setVolumeLoading] = useState(false);

  const rankedSectors = useMemo(() => {
    return (snapshot?.sectors || []).map((sector, index) => ({ ...sector, rank: index + 1 }));
  }, [snapshot]);

  const filteredSectors = useMemo(() => {
    const keyword = normalizeSearchText(query);
    if (!keyword) return rankedSectors;
    return rankedSectors.filter((sector) => sectorSearchText(sector).includes(keyword));
  }, [rankedSectors, query]);

  const defaultSector = filteredSectors.find((sector) => sector.name !== "기타") || rankedSectors.find((sector) => sector.name !== "기타") || rankedSectors[0];
  const selectedSector = rankedSectors.find((sector) => sector.id === selectedId) || defaultSector;
  const maxTradingValue = rankedSectors[0]?.tradingValueMillion || 0;
  const volumeProfileKey = useMemo(() => {
    return (sectorDetail?.stocks || []).slice(0, volumeHistoryLimit).map((stock) => stock.code).join(",");
  }, [sectorDetail?.stocks]);
  const topChartData = rankedSectors.slice(0, 12).map((sector) => ({
    name: shortName(sector.name),
    거래대금: Math.round(sector.tradingValueMillion || 0),
    등락률: Number((sector.weightedChangeRate || sector.changeRate || 0).toFixed(2))
  }));

  useEffect(() => {
    const topSectorId = (rankedSectors.find((sector) => sector.name !== "기타") || rankedSectors[0])?.id;

    if (topSectorId && !selectedId) {
      setSelectedId(topSectorId);
    }
  }, [rankedSectors, selectedId]);

  useEffect(() => {
    if (!query.trim() || !filteredSectors.length) return;
    if (manualSelection && selectedSector && filteredSectors.some((sector) => sector.id === selectedSector.id)) return;
    setSelectedId(filteredSectors[0].id);
  }, [filteredSectors, manualSelection, query, selectedSector]);

  useEffect(() => {
    if (!selectedSector?.id) return;

    let cancelled = false;
    let timer;
    async function loadDetail() {
      setDetailLoading(true);
      try {
        const data = await loadLiveSector(selectedSector, { forceReader: !canUseApi });
        if (!cancelled) setSectorDetail(data);
        return canUseApi ? apiFallbackPollMs : pagesLiveSuccessDelayMs;
      } catch {
        try {
          const data = await loadStaticSector(selectedSector.id);
          if (!cancelled) setSectorDetail(data);
        } catch {
          if (!cancelled) setSectorDetail(null);
        }

        return canUseApi ? apiFallbackPollMs : pagesLiveFailureRetryMs;
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    }

    const run = async () => {
      const nextDelayMs = await loadDetail();
      if (!cancelled) {
        timer = window.setTimeout(run, nextDelayMs);
      }
    };

    void run();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [selectedSector?.id]);

  useEffect(() => {
    if (!volumeProfileKey || !sectorDetail?.stocks?.length) {
      setVolumeProfile(null);
      return;
    }

    let cancelled = false;

    async function loadVolumeProfile() {
      setVolumeLoading(true);
      const staticProfile = buildStaticVolumeProfile(sectorDetail.stocks);

      try {
        if (!cancelled) setVolumeProfile(staticProfile);

        const data = await loadLiveVolumeProfile(sectorDetail.stocks, {
          forceReader: !canUseApi,
          limit: volumeHistoryLimit
        });
        const staticCoverage = (staticProfile?.counts?.week || 0) + (staticProfile?.counts?.month || 0);
        const liveCoverage = (data?.counts?.week || 0) + (data?.counts?.month || 0);

        if (!cancelled && (!staticProfile || liveCoverage >= staticCoverage)) setVolumeProfile(data);
      } finally {
        if (!cancelled) setVolumeLoading(false);
      }
    }

    loadVolumeProfile();
    return () => {
      cancelled = true;
    };
  }, [volumeProfileKey, sectorDetail?.stocks]);

  const breadth = snapshot?.totals?.breadth || { rising: 0, flat: 0, falling: 0 };
  const updatedTime = formatTime(snapshot?.updatedAt);
  const excludedProductCount = snapshot?.totals?.excludedProductCount || snapshot?.precisionWatchlist?.excludedProductCount || 0;

  return (
    <main>
      <header className="app-header">
        <div>
          <span className="brand">
            <BarChart3 size={22} />
            Moneyboard
          </span>
          <h1>국내 섹터 거래대금 모니터</h1>
        </div>
        <div className={`stream-pill ${streamState}`}>
          <Radio size={16} />
          <span>
            {streamState === "live"
              ? "LIVE"
              : streamState === "polling"
                ? "AUTO"
                : streamState === "static"
                  ? "SNAPSHOT"
                  : "OFFLINE"}
          </span>
        </div>
      </header>

      <MarketOverviewStrip overview={snapshot?.overview} />

      <section className="metrics-grid">
        <MetricCard
          icon={Database}
          label="시장 거래대금"
          value={formatTradingValue(snapshot?.totals?.tradingValueMillion)}
          detail={`${snapshot?.totals?.sectorCount || 0}개 섹터 합산 · ETF ${excludedProductCount}개 제외`}
          tone="green"
        />
        <MetricCard
          icon={TrendingUp}
          label="최대 유입 섹터"
          value={rankedSectors[0]?.name || "집계 중"}
          detail={rankedSectors[0] ? formatTradingValue(rankedSectors[0].tradingValueMillion) : "대기"}
          tone="amber"
        />
        <MetricCard
          icon={Activity}
          label="상승/보합/하락"
          value={`${breadth.rising}/${breadth.flat}/${breadth.falling}`}
          detail="전체 편입 종목 기준"
          tone="red"
        />
        <MetricCard icon={Clock3} label="최근 수신" value={updatedTime} detail={error || "자동 갱신"} />
      </section>

      <section className="monitor-layout">
        <section className="workspace workspace-main">
          <section className="sector-panel">
            <div className="panel-header sector-panel-header">
              <div>
                <span className="eyebrow">거래대금 랭킹</span>
                <h2>섹터별 상위 종목</h2>
              </div>
              <div className="search-box">
                <Search size={16} />
                <input
                  value={query}
                  onChange={(event) => {
                    setManualSelection(false);
                    setQuery(event.target.value);
                  }}
                  placeholder="섹터/종목/코드 검색"
                />
              </div>
            </div>
            <div className="sector-grid">
              {filteredSectors.map((sector) => (
                <SectorCard
                  key={sector.id}
                  sector={sector}
                  selected={sector.id === selectedSector?.id}
                  maxValue={maxTradingValue}
                  query={query}
                  onSelect={(nextSector) => {
                    setManualSelection(true);
                    setSelectedId(nextSector.id);
                  }}
                />
              ))}
              {!filteredSectors.length && <div className="empty-sector-card">검색된 섹터/종목이 없습니다.</div>}
            </div>
          </section>

          <section className="analysis-panel">
            <div className="chart-card">
              <div className="chart-title">
                <BarChart3 size={18} />
                <span>상위 섹터 거래대금</span>
              </div>
              <ResponsiveContainer width="100%" height={320}>
                <BarChart data={topChartData} layout="vertical" margin={{ top: 8, right: 14, bottom: 0, left: 8 }}>
                  <CartesianGrid stroke="#e7e9ef" vertical={false} />
                  <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={formatTradingValue} />
                  <YAxis dataKey="name" type="category" tick={{ fontSize: 11 }} width={118} />
                  <Tooltip formatter={(value) => formatTradingValue(value)} />
                  <Bar dataKey="거래대금" radius={[5, 5, 0, 0]}>
                    {topChartData.map((entry) => (
                      <Cell key={entry.name} fill={entry.등락률 >= 0 ? "#2f7d68" : "#c94f4f"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            <SectorDetail
              sector={selectedSector}
              detail={sectorDetail}
              loading={detailLoading}
              volumePeriod={volumePeriod}
              onVolumePeriodChange={setVolumePeriod}
              volumeProfile={volumeProfile}
              volumeLoading={volumeLoading}
              query={query}
            />
          </section>
        </section>

        <FlowAlertPanel alerts={flowAlerts} snapshot={snapshot} />
      </section>

      <footer>
        데이터는 네이버 금융 업종별 시세를 기반으로 후보를 선정하고, 정밀감시 후보는 키움 OpenAPI+ 로컬 브릿지의 실시간 체결값을 우선 반영합니다.
        투자 판단 전 원천 데이터를 확인하세요.
      </footer>
    </main>
  );
}
