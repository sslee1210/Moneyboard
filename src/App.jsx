import { Activity, BarChart3, Clock3, Database, LineChart, Radio, Search, TrendingUp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
  if (millionWon >= 100_000) {
    return `${percentFormatter.format(millionWon / 100_000)}조`;
  }
  if (millionWon >= 100) {
    return `${percentFormatter.format(millionWon / 100)}억`;
  }
  return `${currencyFormatter.format(Math.round(millionWon || 0))}백만`;
}

function formatNumber(value = 0) {
  return currencyFormatter.format(Math.round(value || 0));
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
  const number = Number.isFinite(value) ? value : 0;
  const sign = number > 0 ? "+" : "";
  return `${sign}${percentFormatter.format(number)}%`;
}

function changeClass(value = 0) {
  if (value > 0) return "positive";
  if (value < 0) return "negative";
  return "neutral";
}

function shortName(name = "") {
  return name.length > 8 ? `${name.slice(0, 8)}...` : name;
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
            setSnapshot(data);
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
            setSnapshot(data);
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

function SectorCard({ sector, selected, maxValue, onSelect }) {
  const tradingValue = sector.tradingValueMillion || 0;
  const width = maxValue ? Math.max(4, (tradingValue / maxValue) * 100) : 0;
  const topStocks = (sector.topStocks || []).slice(0, 5);
  const sectorChange = sector.weightedChangeRate ?? sector.changeRate ?? 0;

  const handleKeyDown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(sector);
    }
  };

  return (
    <article
      className={`sector-card-block ${selected ? "is-selected" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(sector)}
      onKeyDown={handleKeyDown}
    >
      <div className="sector-card-head">
        <span className="sector-rank">{sector.rank}</span>
        <div className="sector-title-wrap">
          <strong>{sector.name}</strong>
          <small>{sector.stockCount}종목 · {sector.topStockName || topStocks[0]?.name || "집계 중"}</small>
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
            <li key={stock.code || `${sector.id}-${stock.name}-${index}`}>
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
                  <span>{stock.code} · {stock.market}</span>
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
  volumeLoading
}) {
  const stocks = detail?.stocks || sector?.topStocks || [];
  const periodLabel = volumePeriodLabels[volumePeriod] || "일일";
  const sampleSize = volumeProfile?.sampleSize || Math.min(stocks.length, volumeHistoryLimit);
  const hasSelectedVolume = stocks.length > 0 && (volumePeriod === "day" || (volumeProfile?.counts?.[volumePeriod] || 0) > 0);
  const selectedVolumeTotal =
    volumeProfile?.totals?.[volumePeriod] ??
    stocks.slice(0, sampleSize).reduce((sum, stock) => sum + (stockPeriodVolume(stock, volumeProfile, volumePeriod) || 0), 0);
  const chartData = stocks
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

      <StockTable stocks={stocks} volumeProfile={volumeProfile} />
    </section>
  );
}

export default function App() {
  const { snapshot, streamState, error } = useMarketStream();
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

  const defaultSector = rankedSectors.find((sector) => sector.name !== "기타") || rankedSectors[0];
  const selectedSector = rankedSectors.find((sector) => sector.id === selectedId) || defaultSector;

  const filteredSectors = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return rankedSectors;
    return rankedSectors.filter((sector) => {
      const stockNames = (sector.topStocks || []).map((stock) => stock.name).join(" ");
      return `${sector.name} ${stockNames}`.toLowerCase().includes(keyword);
    });
  }, [rankedSectors, query]);

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
    const shouldFollowLiveTop = !manualSelection && snapshot?.mode === "pages-reader-live";

    if (topSectorId && (!selectedId || (shouldFollowLiveTop && selectedId !== topSectorId))) {
      setSelectedId(topSectorId);
    }
  }, [manualSelection, rankedSectors, selectedId, snapshot?.mode]);

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
  const updatedTime = snapshot?.updatedAt
    ? new Intl.DateTimeFormat("ko-KR", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      }).format(new Date(snapshot.updatedAt))
    : "--:--:--";

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

      <section className="metrics-grid">
        <MetricCard
          icon={Database}
          label="시장 거래대금"
          value={formatTradingValue(snapshot?.totals?.tradingValueMillion)}
          detail={`${snapshot?.totals?.sectorCount || 0}개 섹터 합산`}
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

      <section className="workspace">
        <section className="sector-panel">
          <div className="panel-header sector-panel-header">
            <div>
              <span className="eyebrow">거래대금 랭킹</span>
              <h2>섹터별 상위 종목</h2>
            </div>
            <div className="search-box">
              <Search size={16} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="섹터/종목 검색" />
            </div>
          </div>
          <div className="sector-grid">
            {filteredSectors.map((sector) => (
              <SectorCard
                key={sector.id}
                sector={sector}
                selected={sector.id === selectedSector?.id}
                maxValue={maxTradingValue}
                onSelect={(nextSector) => {
                  setManualSelection(true);
                  setSelectedId(nextSector.id);
                }}
              />
            ))}
            {!filteredSectors.length && <div className="empty-sector-card">검색된 섹터가 없습니다.</div>}
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
          />
        </section>
      </section>

      <footer>
        데이터는 네이버 금융 업종별 시세를 기반으로 자동 집계하며, 국내 증시 기본 데이터 제공처는 KRX로 표시됩니다.
        투자 판단 전 원천 데이터를 확인하세요.
      </footer>
    </main>
  );
}
