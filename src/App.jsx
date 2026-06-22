import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Clock3,
  Database,
  LineChart,
  Radio,
  Search,
  TrendingUp,
} from "lucide-react";
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
  YAxis,
} from "recharts";

const currencyFormatter = new Intl.NumberFormat("ko-KR");
const percentFormatter = new Intl.NumberFormat("ko-KR", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

const staticDataBase = import.meta.env.BASE_URL || "./";
const configuredApiBase = (import.meta.env.VITE_API_BASE_URL || "").replace(
  /\/$/,
  "",
);
const canUseSameOriginApi =
  typeof window !== "undefined" &&
  ["4173", "8787"].includes(window.location.port) &&
  !window.location.hostname.endsWith("github.io");
const canUseApi = Boolean(configuredApiBase || canUseSameOriginApi);
const apiFallbackPollMs = 30_000;
const staticFallbackPollMs = 60_000;
const volumeHistoryLimit = 12;

const volumePeriods = [
  { id: "day", label: "일일" },
  { id: "week", label: "주간" },
  { id: "month", label: "월간" },
];
const volumePeriodLabels = Object.fromEntries(
  volumePeriods.map((period) => [period.id, period.label]),
);

function apiUrl(path) {
  return configuredApiBase ? `${configuredApiBase}${path}` : path;
}

function staticDataUrl(path) {
  const base = staticDataBase.endsWith("/")
    ? staticDataBase
    : `${staticDataBase}/`;
  return `${base}${path}`;
}

async function fetchJson(url) {
  const separator = url.includes("?") ? "&" : "?";
  const response = await fetch(`${url}${separator}t=${Date.now()}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}

function loadStaticMarket() {
  return fetchJson(staticDataUrl("data/market.json"));
}

function loadStaticSector(id) {
  return fetchJson(staticDataUrl(`data/sectors/${id}.json`));
}

async function loadLiveMarket() {
  if (canUseApi) return fetchJson(apiUrl("/api/sectors"));
  return loadStaticMarket();
}

async function loadLiveSector(sector) {
  if (canUseApi) return fetchJson(apiUrl(`/api/sectors/${sector.id}`));
  return loadStaticSector(sector.id);
}

async function loadLiveVolumeProfile(
  stocks,
  { limit = volumeHistoryLimit } = {},
) {
  if (canUseApi) {
    return postJson(apiUrl("/api/volume-profile"), {
      stocks: (stocks || []).slice(0, limit),
      limit,
    });
  }

  return (
    buildStaticVolumeProfile((stocks || []).slice(0, limit)) || {
      sampleSize: 0,
      limit,
      byCode: {},
      counts: { day: 0, week: 0, month: 0 },
      totals: { day: 0, week: 0, month: 0 },
      updatedAt: new Date().toISOString(),
    }
  );
}

function formatTradingValue(millionWon = 0) {
  if (millionWon >= 100_000)
    return `${percentFormatter.format(millionWon / 100_000)}조`;
  if (millionWon >= 100)
    return `${percentFormatter.format(millionWon / 100)}억`;
  return `${currencyFormatter.format(Math.round(millionWon || 0))}백만`;
}

function formatNumber(value = 0) {
  return currencyFormatter.format(Math.round(value || 0));
}

function formatVolume(value) {
  if (value === null || value === undefined) return "-";
  const rounded = Math.round(value || 0);
  if (rounded >= 100_000_000)
    return `${percentFormatter.format(rounded / 100_000_000)}억주`;
  if (rounded >= 10_000)
    return `${percentFormatter.format(rounded / 10_000)}만주`;
  return `${currencyFormatter.format(rounded)}주`;
}

function formatPercent(value = 0) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${percentFormatter.format(value || 0)}%`;
}

function formatRatio(value) {
  if (!Number.isFinite(value)) return "-";
  return `${percentFormatter.format(value)}%`;
}

function flowClass(flow) {
  if (!flow?.bias || flow.bias === "neutral" || flow.bias === "unknown") {
    return "neutral";
  }
  return flow.bias === "buy" ? "positive" : "negative";
}

function stockFlow(stock) {
  return stock?.flow || stock?.supplyFlow || null;
}

function changeClass(value = 0) {
  if (value > 0) return "positive";
  if (value < 0) return "negative";
  return "neutral";
}

function shortName(name = "") {
  return name.length > 8 ? `${name.slice(0, 8)}...` : name;
}

function sortByVolume(sectors = []) {
  return [...sectors].sort((left, right) => {
    const rightVolume = right.volume || 0;
    const leftVolume = left.volume || 0;
    if (rightVolume !== leftVolume) return rightVolume - leftVolume;
    return (right.tradingValueMillion || 0) - (left.tradingValueMillion || 0);
  });
}

function sortStocksByVolume(stocks = []) {
  return [...stocks].sort((left, right) => {
    const volumeGap = (right.volume || 0) - (left.volume || 0);
    if (volumeGap !== 0) return volumeGap;
    return (right.tradeAmountMillion || 0) - (left.tradeAmountMillion || 0);
  });
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
      monthDate: stock.periodVolumes?.date ?? null,
    }))
    .filter((item) => item.day || item.week || item.month);

  if (!items.length) return null;

  return {
    sampleSize: items.length,
    limit: volumeHistoryLimit,
    byCode: Object.fromEntries(items.map((item) => [item.code, item])),
    counts: {
      day: items.filter((item) => item.day !== null && item.day !== undefined)
        .length,
      week: items.filter(
        (item) => item.week !== null && item.week !== undefined,
      ).length,
      month: items.filter(
        (item) => item.month !== null && item.month !== undefined,
      ).length,
    },
    totals: {
      day: items.reduce((sum, item) => sum + (item.day || 0), 0),
      week: items.reduce((sum, item) => sum + (item.week || 0), 0),
      month: items.reduce((sum, item) => sum + (item.month || 0), 0),
    },
    updatedAt: new Date().toISOString(),
  };
}

function useMarketStream() {
  const [snapshot, setSnapshot] = useState(null);
  const [streamState, setStreamState] = useState("connecting");
  const [error, setError] = useState("");

  useEffect(() => {
    let closed = false;
    let fallbackTimer;
    let stream;

    const applySnapshot = (data, state = "live", message = "") => {
      if (closed) return;
      setSnapshot(data);
      setStreamState(state);
      setError(message);
    };

    const loadFallback = async () => {
      try {
        const data = await loadLiveMarket();
        applySnapshot(
          data,
          canUseApi ? "polling" : "static",
          canUseApi ? "자동 갱신" : "정적 스냅샷",
        );
      } catch (apiError) {
        try {
          const data = await loadStaticMarket();
          applySnapshot(data, "static", "정적 스냅샷");
        } catch (staticError) {
          if (!closed) {
            setStreamState("offline");
            setError(staticError.message || apiError.message);
          }
        }
      }
    };

    const startFallbackLoop = (
      delayMs = canUseApi ? apiFallbackPollMs : staticFallbackPollMs,
    ) => {
      const run = async () => {
        await loadFallback();
        if (!closed) fallbackTimer = window.setTimeout(run, delayMs);
      };
      void run();
    };

    if (!canUseApi || !("EventSource" in window)) {
      startFallbackLoop();
      return () => {
        closed = true;
        clearTimeout(fallbackTimer);
      };
    }

    stream = new EventSource(apiUrl("/api/stream"));

    stream.addEventListener("open", () => {
      if (!closed) setStreamState("live");
    });

    stream.addEventListener("market", (event) => {
      try {
        applySnapshot(JSON.parse(event.data), "live", "실시간 갱신");
      } catch (parseError) {
        if (!closed) setError(parseError.message);
      }
    });

    stream.addEventListener("error", () => {
      if (!closed) {
        setStreamState("polling");
        setError("실시간 연결 재시도 중");
      }
    });

    return () => {
      closed = true;
      clearTimeout(fallbackTimer);
      stream?.close();
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

function SectorCard({ sector, selected, maxVolume, onSelect }) {
  const changeRate = sector.weightedChangeRate ?? sector.changeRate ?? 0;
  const volumeWidth = maxVolume
    ? Math.max(6, ((sector.volume || 0) / maxVolume) * 100)
    : 0;
  const stockSource = sector.stocks?.length
    ? sector.stocks
    : sector.topVolumeStocks?.length
      ? sector.topVolumeStocks
      : sector.topStocks || [];

  const topStocks = sortStocksByVolume(stockSource).slice(0, selected ? 12 : 6);
  const maxStockVolume = topStocks[0]?.volume || 0;
  const hiddenStockCount = Math.max(0, stockSource.length - topStocks.length);

  return (
    <button
      className={`sector-card ${selected ? "is-selected" : ""}`}
      type="button"
      onClick={() => onSelect(sector)}
    >
      <div className="sector-card-top">
        <span className="sector-rank">#{sector.rank}</span>
        <span className={`sector-card-change ${changeClass(changeRate)}`}>
          {changeRate >= 0 ? (
            <ArrowUpRight size={15} />
          ) : (
            <ArrowDownRight size={15} />
          )}
          {formatPercent(changeRate)}
        </span>
      </div>

      <div className="sector-card-title">
        <strong>{sector.name}</strong>
        <span>{sector.stockCount || 0}종목 · 거래량 상위 종목 포함</span>
      </div>

      <div className="sector-card-bars">
        <div className="bar-label">
          <span>섹터 거래량</span>
          <strong>{formatVolume(sector.volume)}</strong>
        </div>
        <i style={{ width: `${volumeWidth}%` }} />
      </div>

      <div className="sector-card-meta">
        <span>
          <em>거래대금</em>
          <strong>{formatTradingValue(sector.tradingValueMillion)}</strong>
        </span>
        <span>
          <em>상승/하락</em>
          <strong>
            {sector.risingCount || 0}/{sector.fallingCount || 0}
          </strong>
        </span>
      </div>

      {topStocks.length > 0 && (
        <div
          className="sector-stock-list"
          aria-label={`${sector.name} 거래량 상위 종목`}
        >
          {topStocks.map((stock) => {
            const stockVolumeWidth = maxStockVolume
              ? Math.max(5, ((stock.volume || 0) / maxStockVolume) * 100)
              : 0;
            const stockChangeRate = stock.changeRate || 0;
            const flow = stockFlow(stock);
            const hasFlowRatio =
              Number.isFinite(flow?.buyRatio) && Number.isFinite(flow?.sellRatio);
            const buyRatio = hasFlowRatio ? flow.buyRatio : 50;
            const sellRatio = hasFlowRatio ? flow.sellRatio : 50;
            const foreignNetVolume = flow?.foreignNetVolume;
            const hasForeignFlow = Number.isFinite(foreignNetVolume);

            return (
              <div className="sector-stock-row" key={stock.code}>
                <span className="sector-stock-rank">
                  {topStocks.indexOf(stock) + 1}
                </span>
                <span className="sector-stock-name">
                  <strong>{stock.name}</strong>
                  <span>
                    {stock.code} · {formatNumber(stock.price)}원
                  </span>
                </span>
                <span className="sector-stock-volume">
                  <span className="sector-stock-volume-top">
                    <strong>{formatVolume(stock.volume)}</strong>
                    <em className={changeClass(stockChangeRate)}>
                      {formatPercent(stockChangeRate)}
                    </em>
                  </span>
                  <span className="sector-stock-volume-bar">
                    <i style={{ width: `${stockVolumeWidth}%` }} />
                  </span>
                  <span className="sector-stock-flow">
                    <span className="sector-stock-flow-head">
                      <em>매수 {hasFlowRatio ? formatRatio(flow.buyRatio) : "대기"}</em>
                      <em>매도 {hasFlowRatio ? formatRatio(flow.sellRatio) : "대기"}</em>
                    </span>
                    <span className={`sector-stock-flow-bar ${flowClass(flow)}`}>
                      <i className="buy" style={{ width: `${buyRatio}%` }} />
                      <i className="sell" style={{ width: `${sellRatio}%` }} />
                    </span>
                    <span className="sector-stock-foreign">
                      <em>외국인</em>
                      <strong
                        className={hasForeignFlow ? changeClass(foreignNetVolume) : "neutral"}
                      >
                        {hasForeignFlow ? formatVolume(foreignNetVolume) : "수집 대기"}
                      </strong>
                    </span>
                  </span>
                </span>
              </div>
            );
          })}
          {hiddenStockCount > 0 && (
            <div className="sector-stock-more">
              +{hiddenStockCount}종목 더 보기
            </div>
          )}
        </div>
      )}
    </button>
  );
}

function stockPeriodVolume(stock, volumeProfile, period) {
  if (period === "day") return stock.volume || 0;
  const periodData = volumeProfile?.byCode?.[stock.code];
  return periodData?.[period] ?? stock.periodVolumes?.[period] ?? null;
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
            const periodData =
              volumeProfile?.byCode?.[stock.code] || stock.periodVolumes;

            return (
              <tr key={stock.code}>
                <td>
                  <a href={stock.naverUrl} target="_blank" rel="noreferrer">
                    {stock.name}
                  </a>
                  <span>
                    {stock.code} · {stock.market}
                  </span>
                </td>
                <td>{formatNumber(stock.price)}</td>
                <td className={changeClass(stock.changeRate)}>
                  {formatPercent(stock.changeRate)}
                </td>
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
}) {
  const stocks = detail?.stocks || sector?.topStocks || [];
  const periodLabel = volumePeriodLabels[volumePeriod] || "일일";
  const sampleSize =
    volumeProfile?.sampleSize || Math.min(stocks.length, volumeHistoryLimit);
  const hasSelectedVolume =
    stocks.length > 0 &&
    (volumePeriod === "day" ||
      (volumeProfile?.counts?.[volumePeriod] || 0) > 0);
  const selectedVolumeTotal =
    volumeProfile?.totals?.[volumePeriod] ??
    stocks
      .slice(0, sampleSize)
      .reduce(
        (sum, stock) =>
          sum + (stockPeriodVolume(stock, volumeProfile, volumePeriod) || 0),
        0,
      );
  const chartData = stocks
    .map((stock) => ({
      name: shortName(stock.name),
      거래량: stockPeriodVolume(stock, volumeProfile, volumePeriod) || 0,
      등락률: Number((stock.changeRate || 0).toFixed(2)),
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
          <div
            className="period-toggle"
            role="tablist"
            aria-label="거래량 기간"
          >
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
          <div
            className={`status-dot ${loading || volumeLoading ? "loading" : "live"}`}
          >
            <span />
            {loading || volumeLoading ? "갱신 중" : "동기화"}
          </div>
        </div>
      </div>

      <div className="detail-stats">
        <div>
          <span>거래량</span>
          <strong>{formatVolume(detail?.volume || sector?.volume)}</strong>
          <small>섹터 전체 합산</small>
        </div>
        <div>
          <span>거래대금</span>
          <strong>
            {formatTradingValue(
              detail?.tradingValueMillion || sector?.tradingValueMillion,
            )}
          </strong>
          <small>네이버 금융 기준</small>
        </div>
        <div>
          <span>{periodLabel} 거래량</span>
          <strong>
            {volumeLoading
              ? "수집 중"
              : hasSelectedVolume
                ? formatVolume(selectedVolumeTotal)
                : "-"}
          </strong>
          <small>상위 {sampleSize}종목 기준</small>
        </div>
        <div>
          <span>가중 등락률</span>
          <strong
            className={changeClass(
              detail?.weightedChangeRate || sector?.weightedChangeRate,
            )}
          >
            {formatPercent(
              detail?.weightedChangeRate || sector?.weightedChangeRate,
            )}
          </strong>
          <small>
            상승/하락 {sector?.risingCount || 0}/{sector?.fallingCount || 0}
          </small>
        </div>
      </div>

      <div className="chart-card detail-chart">
        <div className="chart-title">
          <LineChart size={18} />
          <span>{periodLabel} 거래량 상위 종목</span>
        </div>
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart
            data={chartData}
            margin={{ top: 10, right: 10, bottom: 0, left: 0 }}
          >
            <CartesianGrid stroke="#e7e9ef" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} />
            <YAxis
              yAxisId="left"
              tick={{ fontSize: 11 }}
              tickFormatter={formatVolume}
              width={72}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              tick={{ fontSize: 11 }}
              tickFormatter={(value) => `${value}%`}
            />
            <Tooltip
              formatter={(value, name) =>
                name === "거래량" ? formatVolume(value) : `${value}%`
              }
            />
            <Bar
              yAxisId="left"
              dataKey="거래량"
              radius={[4, 4, 0, 0]}
              fill="#2f7d68"
            />
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="등락률"
              stroke="#d65a31"
              strokeWidth={2}
              dot={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
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

  const volumeRankedSectors = useMemo(() => {
    return sortByVolume(snapshot?.sectors || []).map((sector, index) => ({
      ...sector,
      rank: index + 1,
    }));
  }, [snapshot]);

  const defaultSector =
    volumeRankedSectors.find((sector) => sector.name !== "기타") ||
    volumeRankedSectors[0];
  const selectedSector =
    volumeRankedSectors.find((sector) => sector.id === selectedId) ||
    defaultSector;

  const filteredSectors = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return volumeRankedSectors;
    return volumeRankedSectors.filter((sector) => {
      const stockNames = [
        ...(sector.topStocks || []),
        ...(sector.topVolumeStocks || []),
      ]
        .map((stock) => stock.name)
        .join(" ");
      return `${sector.name} ${stockNames}`.toLowerCase().includes(keyword);
    });
  }, [volumeRankedSectors, query]);

  const maxVolume = volumeRankedSectors[0]?.volume || 0;
  const topChartData = volumeRankedSectors.slice(0, 12).map((sector) => ({
    name: shortName(sector.name),
    거래량: Math.round(sector.volume || 0),
    등락률: Number(
      (sector.weightedChangeRate || sector.changeRate || 0).toFixed(2),
    ),
  }));

  const volumeProfileKey = useMemo(() => {
    return (sectorDetail?.stocks || [])
      .slice(0, volumeHistoryLimit)
      .map((stock) => stock.code)
      .join(",");
  }, [sectorDetail?.stocks]);

  useEffect(() => {
    const topSectorId = (
      volumeRankedSectors.find((sector) => sector.name !== "기타") ||
      volumeRankedSectors[0]
    )?.id;
    const shouldFollowLiveTop =
      !manualSelection && snapshot?.mode === "localhost-live";

    if (
      topSectorId &&
      (!selectedId || (shouldFollowLiveTop && selectedId !== topSectorId))
    ) {
      setSelectedId(topSectorId);
    }
  }, [manualSelection, selectedId, snapshot?.mode, volumeRankedSectors]);

  useEffect(() => {
    if (!selectedSector?.id) return;

    let cancelled = false;

    async function loadDetail() {
      setDetailLoading(true);
      try {
        const data = await loadLiveSector(selectedSector);
        if (!cancelled) setSectorDetail(data);
      } catch {
        try {
          const data = await loadStaticSector(selectedSector.id);
          if (!cancelled) setSectorDetail(data);
        } catch {
          if (!cancelled)
            setSectorDetail({
              ...selectedSector,
              stocks: selectedSector.topStocks || [],
            });
        }
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    }

    void loadDetail();
    return () => {
      cancelled = true;
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
      try {
        const data = await loadLiveVolumeProfile(sectorDetail.stocks, {
          limit: volumeHistoryLimit,
        });
        if (!cancelled) setVolumeProfile(data);
      } catch {
        if (!cancelled)
          setVolumeProfile(buildStaticVolumeProfile(sectorDetail.stocks));
      } finally {
        if (!cancelled) setVolumeLoading(false);
      }
    }

    void loadVolumeProfile();
    return () => {
      cancelled = true;
    };
  }, [volumeProfileKey, sectorDetail?.stocks]);

  const breadth = snapshot?.totals?.breadth || {
    rising: 0,
    flat: 0,
    falling: 0,
  };
  const updatedTime = snapshot?.updatedAt
    ? new Intl.DateTimeFormat("ko-KR", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(new Date(snapshot.updatedAt))
    : "--:--:--";
  const streamLabel =
    streamState === "live"
      ? "LIVE"
      : streamState === "polling"
        ? "AUTO"
        : streamState === "static"
          ? "SNAPSHOT"
          : "OFFLINE";

  return (
    <main>
      <header className="app-header">
        <div>
          <span className="brand">
            <BarChart3 size={22} />
            Moneyboard
          </span>
          <h1>국내 섹터 거래량 모니터</h1>
        </div>
        <div className={`stream-pill ${streamState}`}>
          <Radio size={16} />
          <span>{streamLabel}</span>
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
          label="최대 거래량 섹터"
          value={volumeRankedSectors[0]?.name || "집계 중"}
          detail={
            volumeRankedSectors[0]
              ? formatVolume(volumeRankedSectors[0].volume)
              : "대기"
          }
          tone="amber"
        />
        <MetricCard
          icon={Activity}
          label="상승/보합/하락"
          value={`${breadth.rising}/${breadth.flat}/${breadth.falling}`}
          detail="전체 편입 종목 기준"
          tone="red"
        />
        <MetricCard
          icon={Clock3}
          label="최근 수신"
          value={updatedTime}
          detail={error || "자동 갱신"}
        />
      </section>

      <section className="workspace card-workspace">
        <section className="sector-panel sector-card-panel">
          <div className="panel-header sector-card-header">
            <div>
              <span className="eyebrow">거래량 랭킹</span>
              <h2>섹터·종목 카드</h2>
            </div>
            <div className="search-box">
              <Search size={16} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="섹터/종목 검색"
              />
            </div>
          </div>
          <div className="sector-card-grid">
            {filteredSectors.map((sector) => (
              <SectorCard
                key={sector.id}
                sector={sector}
                selected={sector.id === selectedSector?.id}
                maxVolume={maxVolume}
                onSelect={(nextSector) => {
                  setManualSelection(true);
                  setSelectedId(nextSector.id);
                }}
              />
            ))}
          </div>
        </section>

        <section className="analysis-panel">
          <div className="chart-card">
            <div className="chart-title">
              <BarChart3 size={18} />
              <span>거래량 상위 섹터</span>
            </div>
            <ResponsiveContainer width="100%" height={320}>
              <BarChart
                data={topChartData}
                layout="vertical"
                margin={{ top: 8, right: 14, bottom: 0, left: 8 }}
              >
                <CartesianGrid stroke="#e7e9ef" vertical={false} />
                <XAxis
                  type="number"
                  tick={{ fontSize: 11 }}
                  tickFormatter={formatVolume}
                />
                <YAxis
                  dataKey="name"
                  type="category"
                  tick={{ fontSize: 11 }}
                  width={118}
                />
                <Tooltip
                  formatter={(value, name) =>
                    name === "거래량" ? formatVolume(value) : `${value}%`
                  }
                />
                <Bar dataKey="거래량" radius={[5, 5, 0, 0]}>
                  {topChartData.map((entry) => (
                    <Cell
                      key={entry.name}
                      fill={entry.등락률 >= 0 ? "#2f7d68" : "#c94f4f"}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="insight-strip">
            {volumeRankedSectors.slice(0, 3).map((sector) => (
              <article key={sector.id}>
                <span>{sector.rank}</span>
                <strong>{sector.name}</strong>
                <small>
                  {formatVolume(sector.volume)} ·{" "}
                  {formatTradingValue(sector.tradingValueMillion)}
                </small>
                <em
                  className={changeClass(
                    sector.weightedChangeRate || sector.changeRate,
                  )}
                >
                  {(sector.weightedChangeRate || sector.changeRate) >= 0 ? (
                    <ArrowUpRight size={15} />
                  ) : (
                    <ArrowDownRight size={15} />
                  )}
                  {formatPercent(
                    sector.weightedChangeRate || sector.changeRate,
                  )}
                </em>
              </article>
            ))}
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
        데이터는 네이버 금융 업종별 시세를 기반으로 로컬 서버에서 자동
        집계합니다. KIS API는 사용하지 않으며, 투자 판단 전 원천 데이터를
        확인하세요.
      </footer>
    </main>
  );
}
