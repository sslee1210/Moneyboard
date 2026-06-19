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
  TrendingUp
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
  YAxis
} from "recharts";

const currencyFormatter = new Intl.NumberFormat("ko-KR");
const percentFormatter = new Intl.NumberFormat("ko-KR", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2
});
const staticDataBase = import.meta.env.BASE_URL || "/";

function staticDataUrl(path) {
  return `${staticDataBase}${path}`.replace(/\/{2,}/g, "/");
}

async function fetchJson(url) {
  const separator = url.includes("?") ? "&" : "?";
  const response = await fetch(`${url}${separator}t=${Date.now()}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function loadStaticMarket() {
  return fetchJson(staticDataUrl("data/market.json"));
}

function loadStaticSector(id) {
  return fetchJson(staticDataUrl(`data/sectors/${id}.json`));
}

function formatTradingValue(millionWon = 0) {
  if (millionWon >= 100_000) {
    return `${percentFormatter.format(millionWon / 100_000)}조`;
  }
  if (millionWon >= 100) {
    return `${percentFormatter.format(millionWon / 100)}억`;
  }
  return `${currencyFormatter.format(Math.round(millionWon))}백만`;
}

function formatNumber(value = 0) {
  return currencyFormatter.format(Math.round(value));
}

function formatPercent(value = 0) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${percentFormatter.format(value)}%`;
}

function changeClass(value = 0) {
  if (value > 0) return "positive";
  if (value < 0) return "negative";
  return "neutral";
}

function shortName(name) {
  return name.length > 8 ? `${name.slice(0, 8)}...` : name;
}

function useMarketStream() {
  const [snapshot, setSnapshot] = useState(null);
  const [streamState, setStreamState] = useState("connecting");
  const [error, setError] = useState("");

  useEffect(() => {
    let closed = false;
    let fallbackTimer;

    const loadFallback = async () => {
      try {
        const data = await fetchJson("/api/sectors");
        if (!closed) {
          setSnapshot(data);
          setStreamState("polling");
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

    if (window.location.hostname.endsWith("github.io")) {
      loadFallback();
      fallbackTimer = setInterval(loadFallback, 30_000);
      return () => {
        closed = true;
        clearInterval(fallbackTimer);
      };
    }

    if (!("EventSource" in window)) {
      loadFallback();
      fallbackTimer = setInterval(loadFallback, 30_000);
      return () => {
        closed = true;
        clearInterval(fallbackTimer);
      };
    }

    const stream = new EventSource("/api/stream");

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
        loadFallback();
        fallbackTimer = fallbackTimer || setInterval(loadFallback, 30_000);
      }
    });

    return () => {
      closed = true;
      stream.close();
      clearInterval(fallbackTimer);
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

function SectorRow({ sector, selected, maxValue, onSelect }) {
  const width = maxValue ? Math.max(4, (sector.tradingValueMillion / maxValue) * 100) : 0;

  return (
    <button className={`sector-row ${selected ? "is-selected" : ""}`} onClick={() => onSelect(sector)}>
      <span className="sector-rank">{sector.rank}</span>
      <span className="sector-main">
        <strong>{sector.name}</strong>
        <span>{sector.stockCount}종목 · {sector.topStockName || "집계 중"}</span>
        <i style={{ width: `${width}%` }} />
      </span>
      <span className="sector-money">{formatTradingValue(sector.tradingValueMillion)}</span>
      <span className={`sector-change ${changeClass(sector.weightedChangeRate || sector.changeRate)}`}>
        {formatPercent(sector.weightedChangeRate || sector.changeRate)}
      </span>
    </button>
  );
}

function StockTable({ stocks }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>종목</th>
            <th>현재가</th>
            <th>등락률</th>
            <th>거래량</th>
            <th>거래대금</th>
          </tr>
        </thead>
        <tbody>
          {stocks.map((stock) => (
            <tr key={stock.code}>
              <td>
                <a href={stock.naverUrl} target="_blank" rel="noreferrer">
                  {stock.name}
                </a>
                <span>{stock.code} · {stock.market}</span>
              </td>
              <td>{formatNumber(stock.price)}</td>
              <td className={changeClass(stock.changeRate)}>{formatPercent(stock.changeRate)}</td>
              <td>{formatNumber(stock.volume)}</td>
              <td>{formatTradingValue(stock.tradeAmountMillion)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SectorDetail({ sector, detail, loading }) {
  const stocks = detail?.stocks || sector?.topStocks || [];
  const chartData = stocks.slice(0, 12).map((stock) => ({
    name: shortName(stock.name),
    거래대금: Math.round(stock.tradeAmountMillion),
    등락률: Number(stock.changeRate.toFixed(2))
  }));

  return (
    <section className="detail-panel">
      <div className="panel-header">
        <div>
          <span className="eyebrow">선택 섹터</span>
          <h2>{sector?.name || "섹터 선택"}</h2>
        </div>
        <div className={`status-dot ${loading ? "loading" : "live"}`}>
          <span />
          {loading ? "갱신 중" : "동기화"}
        </div>
      </div>

      <div className="detail-stats">
        <div>
          <span>거래대금</span>
          <strong>{formatTradingValue(detail?.tradingValueMillion || sector?.tradingValueMillion)}</strong>
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
          <span>거래대금 상위 종목</span>
        </div>
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={chartData} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#e7e9ef" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} />
            <YAxis yAxisId="left" tick={{ fontSize: 11 }} tickFormatter={formatTradingValue} width={58} />
            <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} tickFormatter={(value) => `${value}%`} />
            <Tooltip formatter={(value, name) => (name === "거래대금" ? formatTradingValue(value) : `${value}%`)} />
            <Bar yAxisId="left" dataKey="거래대금" radius={[4, 4, 0, 0]} fill="#2f7d68" />
            <Line yAxisId="right" type="monotone" dataKey="등락률" stroke="#d65a31" strokeWidth={2} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <StockTable stocks={stocks} />
    </section>
  );
}

export default function App() {
  const { snapshot, streamState, error } = useMarketStream();
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [sectorDetail, setSectorDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const rankedSectors = useMemo(() => {
    return (snapshot?.sectors || []).map((sector, index) => ({ ...sector, rank: index + 1 }));
  }, [snapshot]);

  const selectedSector = rankedSectors.find((sector) => sector.id === selectedId) || rankedSectors[0];

  const filteredSectors = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return rankedSectors;
    return rankedSectors.filter((sector) => {
      const stockNames = (sector.topStocks || []).map((stock) => stock.name).join(" ");
      return `${sector.name} ${stockNames}`.toLowerCase().includes(keyword);
    });
  }, [rankedSectors, query]);

  const maxTradingValue = rankedSectors[0]?.tradingValueMillion || 0;
  const topChartData = rankedSectors.slice(0, 12).map((sector) => ({
    name: shortName(sector.name),
    거래대금: Math.round(sector.tradingValueMillion),
    등락률: Number((sector.weightedChangeRate || sector.changeRate || 0).toFixed(2))
  }));

  useEffect(() => {
    if (!selectedId && rankedSectors.length) {
      setSelectedId(rankedSectors[0].id);
    }
  }, [rankedSectors, selectedId]);

  useEffect(() => {
    if (!selectedSector?.id) return;

    let cancelled = false;
    async function loadDetail() {
      setDetailLoading(true);
      try {
        if (streamState === "static") throw new Error("Static Pages mode");
        const data = await fetchJson(`/api/sectors/${selectedSector.id}`);
        if (!cancelled) setSectorDetail(data);
      } catch {
        try {
          const data = await loadStaticSector(selectedSector.id);
          if (!cancelled) setSectorDetail(data);
        } catch {
          if (!cancelled) setSectorDetail(null);
        }
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    }

    loadDetail();
    const timer = setInterval(loadDetail, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [selectedSector?.id, snapshot?.updatedAt, streamState]);

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
        <aside className="sector-panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">거래대금 랭킹</span>
              <h2>섹터</h2>
            </div>
            <div className="search-box">
              <Search size={16} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="섹터/종목 검색" />
            </div>
          </div>
          <div className="sector-list">
            {filteredSectors.map((sector) => (
              <SectorRow
                key={sector.id}
                sector={sector}
                selected={sector.id === selectedSector?.id}
                maxValue={maxTradingValue}
                onSelect={(nextSector) => setSelectedId(nextSector.id)}
              />
            ))}
          </div>
        </aside>

        <section className="analysis-panel">
          <div className="chart-card">
            <div className="chart-title">
              <BarChart3 size={18} />
              <span>상위 섹터 거래대금</span>
            </div>
            <ResponsiveContainer width="100%" height={320}>
              <BarChart
                data={topChartData}
                layout="vertical"
                margin={{ top: 8, right: 14, bottom: 0, left: 8 }}
              >
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

          <div className="insight-strip">
            {rankedSectors.slice(0, 3).map((sector) => (
              <article key={sector.id}>
                <span>{sector.rank}</span>
                <strong>{sector.name}</strong>
                <small>{formatTradingValue(sector.tradingValueMillion)}</small>
                <em className={changeClass(sector.weightedChangeRate || sector.changeRate)}>
                  {(sector.weightedChangeRate || sector.changeRate) >= 0 ? (
                    <ArrowUpRight size={15} />
                  ) : (
                    <ArrowDownRight size={15} />
                  )}
                  {formatPercent(sector.weightedChangeRate || sector.changeRate)}
                </em>
              </article>
            ))}
          </div>

          <SectorDetail sector={selectedSector} detail={sectorDetail} loading={detailLoading} />
        </section>
      </section>

      <footer>
        데이터는 네이버 금융 업종별 시세를 기반으로 자동 집계하며, 국내 증시 기본 데이터 제공처는 KRX로 표시됩니다.
        투자 판단 전 원천 데이터를 확인하세요.
      </footer>
    </main>
  );
}
