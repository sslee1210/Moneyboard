import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Clock3,
  Database,
  Radio,
  Search,
  Star,
  TrendingUp,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
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

const configuredApiBase = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
const appBasePath = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
const canUseSameOriginApi =
  typeof window !== "undefined" && ["4173", "8787"].includes(window.location.port);
const canUseApi = Boolean(configuredApiBase || canUseSameOriginApi);
const apiFallbackPollMs = 1_000;
const staticFallbackPollMs = 60_000;

function apiUrl(path) {
  return configuredApiBase ? `${configuredApiBase}${path}` : path;
}

function staticDataUrl(path) {
  const cleanPath = String(path || "").replace(/^\//, "");
  return `${appBasePath}/data/${cleanPath}`.replace(/^\/\//, "/");
}

async function fetchJson(url) {
  const separator = url.includes("?") ? "&" : "?";
  const response = await fetch(`${url}${separator}t=${Date.now()}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}

function formatTradingValue(millionWon = 0) {
  const value = Number(millionWon || 0);
  if (!Number.isFinite(value) || value <= 0) return "-";
  if (value >= 1_000_000) return `${percentFormatter.format(value / 1_000_000)}조`;
  if (value >= 100) return `${percentFormatter.format(value / 100)}억`;
  return `${currencyFormatter.format(Math.round(value))}백만`;
}

function formatNumber(value = 0) {
  return currencyFormatter.format(Math.round(value || 0));
}

function formatVolume(value) {
  if (value === null || value === undefined) return "-";
  const rounded = Math.round(value || 0);
  if (rounded >= 100_000_000) return `${percentFormatter.format(rounded / 100_000_000)}억주`;
  if (rounded >= 10_000) return `${percentFormatter.format(rounded / 10_000)}만주`;
  return `${currencyFormatter.format(rounded)}주`;
}

function formatPercent(value = 0) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${percentFormatter.format(value || 0)}%`;
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
      second: "2-digit",
    }).format(new Date(value));
  } catch {
    return "--:--:--";
  }
}

function overviewItems(overview) {
  const preferredOrder = ["kospi", "kosdaq", "nasdaq100-futures", "usd-krw", "sp500"];
  const items = overview?.items || [];
  const byId = new Map(items.map((item) => [item.id, item]));
  return preferredOrder.map((id) => byId.get(id)).filter(Boolean);
}

function changeClass(value = 0) {
  if (value > 0) return "positive";
  if (value < 0) return "negative";
  return "neutral";
}

function shortName(name = "") {
  return name.length > 9 ? `${name.slice(0, 9)}…` : name;
}

function sortSectorsByTradingValue(sectors = []) {
  return [...sectors].sort((left, right) => {
    const tradingGap = (right.tradingValueMillion || 0) - (left.tradingValueMillion || 0);
    if (tradingGap !== 0) return tradingGap;
    return (right.volume || 0) - (left.volume || 0);
  });
}

function sortStocksByTradingValue(stocks = []) {
  return [...stocks].sort((left, right) => {
    const tradingGap = (right.tradeAmountMillion || 0) - (left.tradeAmountMillion || 0);
    if (tradingGap !== 0) return tradingGap;
    return (right.volume || 0) - (left.volume || 0);
  });
}

function sparklinePath(points, width = 180, height = 46, padding = 3) {
  const values = points
    .map((point) => Number(point.value))
    .filter((value) => Number.isFinite(value));

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

function validationMessage(snapshot, fallback = "") {
  const validation = snapshot?.validation;
  if (!validation) return fallback;
  const status = validation.status === "ok" ? "검증 OK" : "검증 경고";
  return `${status} · 오류 ${validation.errorCount || 0}`;
}

function useMarketStream() {
  const [snapshot, setSnapshot] = useState(null);
  const [streamState, setStreamState] = useState("connecting");
  const [error, setError] = useState("");

  useEffect(() => {
    let closed = false;
    let stream;
    let timer;

    const applySnapshot = (data, state = "live", message = "") => {
      if (closed) return;
      setSnapshot(data);
      setStreamState(state);
      setError(message);
    };

    const pollApi = async () => {
      try {
        const data = await fetchJson(apiUrl("/api/sectors"));
        applySnapshot(data, "polling", validationMessage(data, "1초 폴링 갱신"));
      } catch (pollError) {
        if (!closed) {
          setStreamState("offline");
          setError(pollError.message);
        }
      } finally {
        if (!closed) timer = window.setTimeout(pollApi, apiFallbackPollMs);
      }
    };

    const pollStatic = async () => {
      try {
        const data = await fetchJson(staticDataUrl("market.json"));
        applySnapshot(data, "static", validationMessage(data, "정적 스냅샷 수신"));
      } catch (staticError) {
        if (!closed) {
          setStreamState("offline");
          setError(staticError.message);
        }
      } finally {
        if (!closed) timer = window.setTimeout(pollStatic, staticFallbackPollMs);
      }
    };

    if (!canUseApi) {
      void pollStatic();
      return () => {
        closed = true;
        clearTimeout(timer);
      };
    }

    if (!("EventSource" in window)) {
      void pollApi();
      return () => {
        closed = true;
        clearTimeout(timer);
      };
    }

    stream = new EventSource(apiUrl("/api/stream"));
    stream.addEventListener("open", () => {
      if (!closed) setStreamState("live");
    });
    stream.addEventListener("market", (event) => {
      try {
        const data = JSON.parse(event.data);
        applySnapshot(data, "live", validationMessage(data, "1초 스트림 갱신"));
      } catch (parseError) {
        if (!closed) setError(parseError.message);
      }
    });
    stream.addEventListener("error", () => {
      if (!closed) {
        setStreamState("polling");
        setError("스트림 연결 끊김 · 1초 폴링 전환");
        stream?.close();
        void pollApi();
      }
    });

    return () => {
      closed = true;
      clearTimeout(timer);
      stream?.close();
    };
  }, []);

  return { snapshot, streamState, error };
}

function MarketOverviewStrip({ overview }) {
  const items = overviewItems(overview);

  return (
    <section className="market-overview-strip" aria-label="시장 주요 지표">
      {items.map((item) => {
        const changeRate = item.changeRate || 0;
        const points = item.points || [];
        const path = sparklinePath(points);
        const qualityLabel =
          item.dataQuality === "ok" ? `${item.pointCount || points.length}p` : "지연/부족";

        return (
          <article className={`market-overview-card ${changeClass(changeRate)}`} key={item.id}>
            <div className="market-overview-head">
              <span>{item.label}</span>
              <em>{item.symbol}</em>
            </div>
            <div className="market-overview-main">
              <strong>{formatOverviewValue(item)}</strong>
              <small className={changeClass(changeRate)}>{formatPercent(changeRate)}</small>
            </div>
            <svg className="market-sparkline" viewBox="0 0 180 46" preserveAspectRatio="none" role="img">
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

function MetricCard({ icon: Icon, label, value, detail }) {
  return (
    <section className="metric-card">
      <span className="metric-icon">
        <Icon size={18} />
      </span>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </section>
  );
}

function RankStar({ rank }) {
  if (rank > 3) return null;
  return (
    <Star
      className={`rank-star ${rank === 1 ? "gold" : "silver"}`}
      size={16}
      fill="currentColor"
      aria-label={`${rank}위`}
    />
  );
}

function SectorTradingCard({ sector, selected, maxTradingValue, onSelect }) {
  const changeRate = sector.weightedChangeRate ?? sector.changeRate ?? 0;
  const barWidth = maxTradingValue
    ? Math.max(5, ((sector.tradingValueMillion || 0) / maxTradingValue) * 100)
    : 0;
  const topStocks = sortStocksByTradingValue(
    sector.stocks?.length
      ? sector.stocks
      : sector.topTradingValueStocks?.length
        ? sector.topTradingValueStocks
        : sector.topStocks || [],
  ).slice(0, 5);

  return (
    <button
      className={`sector-trading-card ${selected ? "is-selected" : ""}`}
      type="button"
      onClick={() => onSelect(sector)}
    >
      <div className="sector-card-head">
        <span className="sector-rank">
          <RankStar rank={sector.rank} />#{sector.rank}
        </span>
        <span className={`sector-change ${changeClass(changeRate)}`}>
          {changeRate >= 0 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
          {formatPercent(changeRate)}
        </span>
      </div>

      <div className="sector-card-title">
        <strong>{sector.name}</strong>
        <small>
          {sector.stockCount || 0}종목
          {sector.excludedEtfEtnCount ? ` · ETF/ETN ${sector.excludedEtfEtnCount}개 제외` : ""}
        </small>
      </div>

      <div className="sector-money">
        <span>당일 거래대금</span>
        <strong>{formatTradingValue(sector.tradingValueMillion)}</strong>
      </div>
      <div className="sector-bar">
        <i style={{ width: `${barWidth}%` }} />
      </div>

      <div className="sector-card-sub">
        <span>거래량 {formatVolume(sector.volume)}</span>
        <span>{sector.validation?.status === "ok" ? "검증 OK" : "검증 중"}</span>
      </div>

      <div className="top-stock-list">
        {topStocks.map((stock, index) => (
          <span key={stock.code || `${stock.name}-${index}`}>
            <em>{index + 1}</em>
            <strong title={stock.name}>{stock.name}</strong>
            <small>{formatTradingValue(stock.tradeAmountMillion)}</small>
          </span>
        ))}
        {!topStocks.length && <p>종목 집계 대기</p>}
      </div>
    </button>
  );
}

function TopTradingPanel({ sectors }) {
  const chartData = sectors.slice(0, 12).map((sector) => ({
    name: shortName(sector.name),
    거래대금: Math.round(sector.tradingValueMillion || 0),
    등락률: Number((sector.weightedChangeRate || sector.changeRate || 0).toFixed(2)),
  }));

  return (
    <section className="panel top-trading-panel">
      <div className="panel-header compact">
        <div>
          <span>Trading Value Leaders</span>
          <h2>거래대금 상위 섹터</h2>
        </div>
      </div>
      <div className="leader-chart">
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 14, bottom: 0, left: 4 }}>
            <CartesianGrid stroke="#38516a" vertical={false} />
            <XAxis type="number" tick={{ fontSize: 13, fill: "#d5e3ef" }} tickFormatter={formatTradingValue} />
            <YAxis dataKey="name" type="category" tick={{ fontSize: 14, fill: "#ffffff" }} width={118} />
            <Tooltip
              contentStyle={{ background: "#12202d", border: "1px solid #5a7894", color: "#ffffff" }}
              formatter={(value, name) => (name === "거래대금" ? formatTradingValue(value) : `${value}%`)}
            />
            <Bar dataKey="거래대금" radius={[0, 4, 4, 0]}>
              {chartData.map((entry) => (
                <Cell key={entry.name} fill={entry.등락률 >= 0 ? "#ff6d6d" : "#65a9ff"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function SelectedSectorPanel({ sector, detail, loading }) {
  const changeRate = detail?.weightedChangeRate ?? sector?.weightedChangeRate ?? sector?.changeRate ?? 0;

  return (
    <section className="panel selected-sector-panel">
      <div className="panel-header compact">
        <div>
          <span>Selected Sector</span>
          <h2>{sector?.name || "섹터 선택"}</h2>
        </div>
        <div className={`sync-badge ${loading ? "loading" : "live"}`}>
          <i />
          {loading ? "갱신 중" : detail?.validation?.status === "ok" ? "검증 OK" : "동기화"}
        </div>
      </div>
      <div className="selected-stats">
        <div>
          <span>당일 거래대금</span>
          <strong>{formatTradingValue(detail?.tradingValueMillion ?? sector?.tradingValueMillion)}</strong>
          <small>ETF/ETN/ELW 제외</small>
        </div>
        <div>
          <span>거래량</span>
          <strong>{formatVolume(detail?.volume ?? sector?.volume)}</strong>
          <small>일반 종목 기준</small>
        </div>
        <div>
          <span>가중 등락률</span>
          <strong className={changeClass(changeRate)}>{formatPercent(changeRate)}</strong>
          <small>상승/보합/하락 {sector?.risingCount || 0}/{sector?.flatCount || 0}/{sector?.fallingCount || 0}</small>
        </div>
      </div>
    </section>
  );
}

function SelectedStocksPanel({ sector, detail, loading }) {
  const stocks = useMemo(() => {
    const source = detail?.stocks?.length
      ? detail.stocks
      : sector?.stocks?.length
        ? sector.stocks
        : sector?.topTradingValueStocks?.length
          ? sector.topTradingValueStocks
          : sector?.topStocks || [];
    return sortStocksByTradingValue(source).slice(0, 20);
  }, [detail?.stocks, sector?.stocks, sector?.topTradingValueStocks, sector?.topStocks]);

  return (
    <section className="panel selected-stocks-panel">
      <div className="panel-header">
        <div>
          <span>Selected Sector Stocks</span>
          <h2>{sector?.name || "선택 섹터"} 거래대금 상위 종목</h2>
        </div>
        <div className={`sync-badge ${loading ? "loading" : "live"}`}>
          <i />
          {loading ? "상세 수집" : detail?.validation?.status === "ok" ? "검증 OK" : "상세 동기화"}
        </div>
      </div>

      <div className="stock-table-wrap">
        <table>
          <thead>
            <tr>
              <th>순위</th>
              <th>종목</th>
              <th>현재가</th>
              <th>등락률</th>
              <th>거래대금</th>
              <th>거래량</th>
              <th>시장</th>
            </tr>
          </thead>
          <tbody>
            {stocks.map((stock, index) => (
              <tr key={stock.code || `${stock.name}-${index}`}>
                <td>{index + 1}</td>
                <td>
                  <a href={stock.naverUrl} target="_blank" rel="noreferrer">
                    {stock.name}
                  </a>
                  <span>{stock.code}</span>
                </td>
                <td>{formatNumber(stock.price)}</td>
                <td className={changeClass(stock.changeRate)}>{formatPercent(stock.changeRate)}</td>
                <td>{formatTradingValue(stock.tradeAmountMillion)}</td>
                <td>{formatVolume(stock.volume)}</td>
                <td>{stock.market || stock.tradingValueValidation?.status || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function LoadingState({ error }) {
  return (
    <main className="moneyboard-app">
      <section className="panel empty-state">
        <span className="brand">
          <BarChart3 size={22} />
          Moneyboard
        </span>
        <h1>데이터 수신 대기 중</h1>
        <p>로컬 서버 또는 GitHub Pages 스냅샷에서 검증된 네이버 금융 섹터 데이터를 수신합니다.</p>
        {error && <code>{error}</code>}
      </section>
    </main>
  );
}

export default function App() {
  const { snapshot, streamState, error } = useMarketStream();
  const [selectedId, setSelectedId] = useState("");
  const [manualSelection, setManualSelection] = useState(false);
  const [query, setQuery] = useState("");
  const [sectorDetail, setSectorDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const rankedSectors = useMemo(() => {
    return sortSectorsByTradingValue(snapshot?.sectors || []).map((sector, index) => ({
      ...sector,
      rank: index + 1,
    }));
  }, [snapshot]);

  const defaultSector = rankedSectors.find((sector) => sector.name !== "기타") || rankedSectors[0];
  const selectedSector = rankedSectors.find((sector) => sector.id === selectedId) || defaultSector;

  const filteredSectors = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const topTwelve = rankedSectors.slice(0, 12);
    if (!keyword) return topTwelve;
    return rankedSectors
      .filter((sector) => {
        const stockNames = [
          ...(sector.stocks || []),
          ...(sector.topTradingValueStocks || []),
          ...(sector.topStocks || []),
        ]
          .map((stock) => stock.name)
          .join(" ");
        return `${sector.name} ${stockNames}`.toLowerCase().includes(keyword);
      })
      .slice(0, 12);
  }, [rankedSectors, query]);

  const maxTradingValue = rankedSectors[0]?.tradingValueMillion || 0;

  useEffect(() => {
    const topSectorId = rankedSectors.find((sector) => sector.name !== "기타")?.id || rankedSectors[0]?.id;
    if (topSectorId && (!selectedId || (!manualSelection && selectedId !== topSectorId))) {
      setSelectedId(topSectorId);
    }
  }, [manualSelection, rankedSectors, selectedId]);

  useEffect(() => {
    if (!selectedSector?.id) return;

    let cancelled = false;

    async function loadDetail() {
      setDetailLoading(true);
      try {
        const data = await fetchJson(
          canUseApi ? apiUrl(`/api/sectors/${selectedSector.id}`) : staticDataUrl(`sectors/${selectedSector.id}.json`),
        );
        if (!cancelled) setSectorDetail(data);
      } catch {
        if (!cancelled) setSectorDetail(selectedSector);
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    }

    void loadDetail();
    return () => {
      cancelled = true;
    };
  }, [selectedSector?.id, snapshot?.updatedAt]);

  if (!snapshot || !Array.isArray(snapshot.sectors)) {
    return <LoadingState error={error} />;
  }

  const breadth = snapshot?.totals?.breadth || { rising: 0, flat: 0, falling: 0 };
  const updatedTime = formatTime(snapshot?.updatedAt || snapshot?.generatedAt);
  const streamLabel =
    streamState === "live"
      ? "LIVE"
      : streamState === "polling"
        ? "POLLING"
        : streamState === "static"
          ? "STATIC"
          : "OFFLINE";

  return (
    <main className="moneyboard-app">
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
          <span>{streamLabel}</span>
        </div>
      </header>

      <MarketOverviewStrip overview={snapshot?.overview} />

      <section className="metrics-grid">
        <MetricCard
          icon={Database}
          label="시장 거래대금"
          value={formatTradingValue(snapshot?.totals?.tradingValueMillion)}
          detail={`${snapshot?.totals?.sectorCount || 0}개 섹터 · ETF/ETN/ELW 제외`}
        />
        <MetricCard
          icon={TrendingUp}
          label="최대 거래대금 섹터"
          value={rankedSectors[0]?.name || "집계 중"}
          detail={
            rankedSectors[0]
              ? `${formatTradingValue(rankedSectors[0].tradingValueMillion)} · ${formatVolume(rankedSectors[0].volume)}`
              : "대기"
          }
        />
        <MetricCard
          icon={Activity}
          label="상승/보합/하락"
          value={`${breadth.rising}/${breadth.flat}/${breadth.falling}`}
          detail="전체 편입 종목 기준"
        />
        <MetricCard
          icon={Clock3}
          label="최근 수신"
          value={updatedTime}
          detail={error || validationMessage(snapshot, `${Math.round((snapshot?.refreshMs || 1000) / 1000)}초 자동 갱신`)}
        />
      </section>

      <section className="panel ranking-panel">
        <div className="panel-header">
          <div>
            <span>Trading Value Ranking</span>
            <h2>거래대금 랭킹 섹터 12</h2>
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

        <div className="sector-grid-12">
          {filteredSectors.map((sector) => (
            <SectorTradingCard
              key={sector.id}
              sector={sector}
              selected={sector.id === selectedSector?.id}
              maxTradingValue={maxTradingValue}
              onSelect={(nextSector) => {
                setManualSelection(true);
                setSelectedId(nextSector.id);
              }}
            />
          ))}
        </div>
      </section>

      <section className="below-ranking">
        <TopTradingPanel sectors={rankedSectors} />
        <SelectedSectorPanel
          sector={selectedSector}
          detail={sectorDetail}
          loading={detailLoading}
        />
      </section>

      <SelectedStocksPanel
        sector={selectedSector}
        detail={sectorDetail}
        loading={detailLoading}
      />

      <footer>
        섹터/종목 데이터는 네이버 금융 업종별 시세를 기반으로 수집하며, 거래대금 컬럼은 현재가×거래량 검증 후 표시합니다.
        로컬 서버는 1초 단위 라이브 동기화, GitHub Pages는 Actions가 생성한 검증 스냅샷을 사용합니다.
      </footer>
    </main>
  );
}
