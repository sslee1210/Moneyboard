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
  Line,
  LineChart,
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
const canUseSameOriginApi =
  typeof window !== "undefined" && ["4173", "8787"].includes(window.location.port);
const canUseApi = Boolean(configuredApiBase || canUseSameOriginApi);
const apiFallbackPollMs = 30_000;

function apiUrl(path) {
  return configuredApiBase ? `${configuredApiBase}${path}` : path;
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

    const poll = async () => {
      try {
        const data = await fetchJson(apiUrl("/api/sectors"));
        applySnapshot(data, "polling", "자동 갱신");
      } catch (pollError) {
        if (!closed) {
          setStreamState("offline");
          setError(pollError.message);
        }
      } finally {
        if (!closed) timer = window.setTimeout(poll, apiFallbackPollMs);
      }
    };

    if (!canUseApi || !("EventSource" in window)) {
      void poll();
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
        applySnapshot(JSON.parse(event.data), "live", "실시간 갱신");
      } catch (parseError) {
        if (!closed) setError(parseError.message);
      }
    });
    stream.addEventListener("error", () => {
      if (!closed) {
        setStreamState("polling");
        setError("실시간 연결 끊김 · 폴링 전환");
        stream?.close();
        void poll();
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
        const chartData = (item.points || []).map((point, index) => ({
          index,
          value: point.value,
        }));

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
            <div className="market-overview-chart">
              {chartData.length > 1 ? (
                <ResponsiveContainer width="100%" height={42}>
                  <LineChart data={chartData} margin={{ top: 5, right: 0, bottom: 2, left: 0 }}>
                    <Line
                      dataKey="value"
                      dot={false}
                      isAnimationActive={false}
                      stroke={changeRate >= 0 ? "#ff6565" : "#5da2ff"}
                      strokeWidth={2}
                      type="monotone"
                    />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <span className="market-overview-empty">chart pending</span>
              )}
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
      size={15}
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
        <span>일반 종목 기준</span>
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
        <ResponsiveContainer width="100%" height={270}>
          <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#26394c" vertical={false} />
            <XAxis type="number" tick={{ fontSize: 11, fill: "#a6b7c8" }} tickFormatter={formatTradingValue} />
            <YAxis dataKey="name" type="category" tick={{ fontSize: 12, fill: "#eef5fb" }} width={102} />
            <Tooltip
              contentStyle={{ background: "#101b27", border: "1px solid #39506a", color: "#f4f8fb" }}
              formatter={(value, name) => (name === "거래대금" ? formatTradingValue(value) : `${value}%`)}
            />
            <Bar dataKey="거래대금" radius={[0, 4, 4, 0]}>
              {chartData.map((entry) => (
                <Cell key={entry.name} fill={entry.등락률 >= 0 ? "#f05d5d" : "#4f9dff"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function SelectedSectorPanel({ sector }) {
  const changeRate = sector?.weightedChangeRate ?? sector?.changeRate ?? 0;
  return (
    <section className="panel selected-sector-panel">
      <div className="panel-header compact">
        <div>
          <span>Selected Sector</span>
          <h2>{sector?.name || "섹터 선택"}</h2>
        </div>
      </div>
      <div className="selected-stats">
        <div>
          <span>당일 거래대금</span>
          <strong>{formatTradingValue(sector?.tradingValueMillion)}</strong>
          <small>ETF/ETN/ELW 제외</small>
        </div>
        <div>
          <span>거래량</span>
          <strong>{formatVolume(sector?.volume)}</strong>
          <small>일반 종목 기준</small>
        </div>
        <div>
          <span>가중 등락률</span>
          <strong className={changeClass(changeRate)}>{formatPercent(changeRate)}</strong>
          <small>상승/하락 {sector?.risingCount || 0}/{sector?.fallingCount || 0}</small>
        </div>
      </div>
    </section>
  );
}

function SelectedStocksTable({ sector }) {
  const stocks = sortStocksByTradingValue(sector?.stocks || []).slice(0, 20);

  return (
    <section className="panel selected-stocks-panel">
      <div className="panel-header">
        <div>
          <span>Selected Sector Stocks</span>
          <h2>{sector?.name || "선택 섹터"} 거래대금 상위 종목</h2>
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
              <tr key={stock.code}>
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
                <td>{stock.market}</td>
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
        <span className="brand">Moneyboard</span>
        <h1>데이터 수신 대기 중</h1>
        <p>localhost:4173 서버는 켜졌지만 아직 시장 스냅샷을 받지 못했습니다.</p>
        {error && <code>{error}</code>}
      </section>
    </main>
  );
}

export default function App() {
  const { snapshot, streamState, error } = useMarketStream();
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");

  const rankedSectors = useMemo(() => {
    return sortSectorsByTradingValue(snapshot?.sectors || []).map((sector, index) => ({
      ...sector,
      rank: index + 1,
    }));
  }, [snapshot]);

  const filteredSectors = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const base = rankedSectors.slice(0, 12);
    if (!keyword) return base;
    return rankedSectors
      .filter((sector) => {
        const stockNames = (sector.stocks || []).map((stock) => stock.name).join(" ");
        return `${sector.name} ${stockNames}`.toLowerCase().includes(keyword);
      })
      .slice(0, 12);
  }, [rankedSectors, query]);

  const selectedSector =
    rankedSectors.find((sector) => sector.id === selectedId) || rankedSectors[0] || null;
  const maxTradingValue = rankedSectors[0]?.tradingValueMillion || 0;

  useEffect(() => {
    if (!selectedId && rankedSectors[0]?.id) setSelectedId(rankedSectors[0].id);
  }, [rankedSectors, selectedId]);

  if (!snapshot || !Array.isArray(snapshot.sectors)) return <LoadingState error={error} />;

  const breadth = snapshot?.totals?.breadth || { rising: 0, flat: 0, falling: 0 };
  const updatedTime = snapshot?.updatedAt
    ? new Intl.DateTimeFormat("ko-KR", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(new Date(snapshot.updatedAt))
    : "--:--:--";
  const streamLabel = streamState === "live" ? "LIVE" : streamState === "polling" ? "AUTO" : "OFFLINE";

  return (
    <main className="moneyboard-app">
      <header className="app-header">
        <div>
          <span className="brand"><BarChart3 size={22} /> Moneyboard</span>
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
          detail={`${snapshot?.totals?.sectorCount || 0}개 섹터 · ETF/ETN 제외`}
        />
        <MetricCard
          icon={TrendingUp}
          label="최대 거래대금 섹터"
          value={rankedSectors[0]?.name || "집계 중"}
          detail={rankedSectors[0] ? `${formatTradingValue(rankedSectors[0].tradingValueMillion)} · ${formatVolume(rankedSectors[0].volume)}` : "대기"}
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
          detail={error || `${Math.round((snapshot?.refreshMs || 30000) / 1000)}초 자동 갱신`}
        />
      </section>

      <section className="panel ranking-panel">
        <div className="panel-header">
          <div>
            <span>Trading Value Ranking</span>
            <h2>거래대금 랭킹 섹터 12</h2>
          </div>
          <label className="search-box">
            <Search size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="섹터/종목 검색" />
          </label>
        </div>
        <div className="sector-grid-12">
          {filteredSectors.map((sector) => (
            <SectorTradingCard
              key={sector.id}
              sector={sector}
              selected={sector.id === selectedSector?.id}
              maxTradingValue={maxTradingValue}
              onSelect={(nextSector) => setSelectedId(nextSector.id)}
            />
          ))}
        </div>
      </section>

      <section className="below-ranking">
        <TopTradingPanel sectors={rankedSectors} />
        <SelectedSectorPanel sector={selectedSector} />
      </section>

      <SelectedStocksTable sector={selectedSector} />

      <footer>
        데이터는 네이버 금융 업종별 시세를 기반으로 로컬 서버에서 자동 집계합니다. ETF/ETN/ELW는 거래대금 취합과 랭킹에서 제외합니다. KIS API는 사용하지 않습니다.
      </footer>
    </main>
  );
}