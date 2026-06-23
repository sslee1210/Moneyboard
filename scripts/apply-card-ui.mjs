import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function file(p) { return path.join(root, p); }

const sectorCardFunction = String.raw`function SectorRow({ sector, selected, maxValue, onSelect }) {
  const width = maxValue ? Math.max(4, (sector.tradingValueMillion / maxValue) * 100) : 0;
  const changeRate = sector.weightedChangeRate || sector.changeRate || 0;
  const stockSource = sector.topTradingValueStocks?.length
    ? sector.topTradingValueStocks
    : sector.topStocks?.length
      ? sector.topStocks
      : sector.stocks || [];
  const topStocks = [...stockSource]
    .sort((a, b) => {
      const leftMoney = a.tradeAmountMillion || a.tradingValueMillion || 0;
      const rightMoney = b.tradeAmountMillion || b.tradingValueMillion || 0;
      return rightMoney - leftMoney || (b.volume || 0) - (a.volume || 0);
    })
    .slice(0, 5);

  return (
    <button className={"sector-row sector-card-block " + (selected ? "is-selected" : "")} onClick={() => onSelect(sector)}>
      <div className="sector-card-head">
        <span className="sector-rank">{sector.rank}</span>
        <div className="sector-card-title">
          <strong>{sector.name}</strong>
          <small>{sector.stockCount || 0}종목 · {topStocks[0]?.name || sector.topStockName || "집계 중"}</small>
        </div>
        <span className={"sector-change " + changeClass(changeRate)}>
          {changeRate >= 0 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
          {formatPercent(changeRate)}
        </span>
      </div>

      <div className="sector-card-money">
        <span>섹터 거래대금</span>
        <strong>{formatTradingValue(sector.tradingValueMillion)}</strong>
      </div>
      <div className="sector-card-bar"><i style={{ width: width + "%" }} /></div>

      <div className="sector-card-stocklist" aria-label={sector.name + " 상위 종목"}>
        {topStocks.map((stock, index) => {
          const money = stock.tradeAmountMillion ?? stock.tradingValueMillion ?? 0;
          const stockChange = stock.changeRate ?? 0;
          return (
            <div className="sector-card-stock" key={stock.code || stock.name || index}>
              <span className="stock-rank">{index + 1}</span>
              <span className="stock-name" title={stock.name}>{stock.name}</span>
              <span className={"stock-change " + changeClass(stockChange)}>{formatPercent(stockChange)}</span>
              <span className="stock-money">{formatTradingValue(money)}</span>
            </div>
          );
        })}
        {!topStocks.length && <p>상위 종목 집계 대기</p>}
      </div>
    </button>
  );
}`;

const app = file('src/App.jsx');
if (!existsSync(app)) {
  throw new Error('[card-ui] src/App.jsx not found');
}

let appSource = readFileSync(app, 'utf8');
const start = appSource.indexOf('function SectorRow({ sector, selected, maxValue, onSelect }) {');
const end = appSource.indexOf('function stockPeriodVolume', start);

if (start < 0 || end < 0) {
  throw new Error('[card-ui] SectorRow block not found. Restore src/App.jsx from the naver-yahoo-my-version branch and retry.');
}

appSource = `${appSource.slice(0, start)}${sectorCardFunction}\n\n${appSource.slice(end)}`;
writeFileSync(app, appSource, 'utf8');
console.log('[card-ui] sector card block UI applied to src/App.jsx');

const cssPatch = String.raw`

/* card-block-ui */
.sector-list {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
  padding: 12px;
}

.sector-row.sector-card-block {
  display: block;
  width: 100%;
  min-height: 218px;
  margin: 0;
  padding: 14px;
  border: 1px solid #dde5de;
  border-radius: 14px;
  background: #ffffff;
  box-shadow: 0 10px 22px rgba(25, 31, 35, 0.045);
  color: #1f2328;
  cursor: pointer;
  text-align: left;
}

.sector-row.sector-card-block:hover,
.sector-row.sector-card-block.is-selected {
  border-color: rgba(47, 125, 104, 0.42);
  background: #f1f8f3;
}

.sector-card-head {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: start;
}

.sector-card-head .sector-rank {
  width: 30px;
  height: 30px;
  border-radius: 10px;
  background: #17202a;
  color: #fff;
}

.sector-card-title {
  min-width: 0;
}

.sector-card-title strong {
  display: block;
  overflow: hidden;
  color: #151a1f;
  font-size: 17px;
  font-weight: 900;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sector-card-title small {
  display: block;
  overflow: hidden;
  margin-top: 4px;
  color: #6d767c;
  font-size: 12px;
  font-weight: 750;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sector-card-head .sector-change {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 12px;
  font-weight: 900;
  text-align: right;
  white-space: nowrap;
}

.sector-card-money {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-top: 12px;
}

.sector-card-money span {
  color: #737c82;
  font-size: 12px;
  font-weight: 800;
}

.sector-card-money strong {
  color: #151a1f;
  font-size: 18px;
  font-weight: 900;
}

.sector-card-bar {
  height: 6px;
  margin-top: 8px;
  overflow: hidden;
  border-radius: 999px;
  background: #e7ece7;
}

.sector-card-bar i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: #2f7d68;
}

.sector-card-stocklist {
  display: grid;
  gap: 6px;
  margin-top: 12px;
}

.sector-card-stock {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) 62px 74px;
  gap: 7px;
  align-items: center;
  min-height: 28px;
  padding: 5px 7px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.82);
}

.stock-rank {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 999px;
  background: #edf2ed;
  color: #596366;
  font-size: 11px;
  font-weight: 900;
}

.stock-name {
  overflow: hidden;
  color: #1d2329;
  font-size: 12px;
  font-weight: 850;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stock-change,
.stock-money {
  font-size: 12px;
  font-weight: 850;
  text-align: right;
  white-space: nowrap;
}

.stock-money {
  color: #3f494e;
}

.sector-card-stocklist p {
  margin: 0;
  color: #7b8387;
  font-size: 12px;
  font-weight: 750;
}
`;

const css = file('src/styles.css');
if (!existsSync(css)) {
  throw new Error('[card-ui] src/styles.css not found');
}

let cssSource = readFileSync(css, 'utf8');
cssSource = cssSource.replace(/\n\/\* card-block-ui \*\/[\s\S]*$/m, '');
cssSource += cssPatch;
writeFileSync(css, cssSource, 'utf8');
console.log('[card-ui] card block CSS applied to src/styles.css');
