import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function file(p) { return path.join(root, p); }

const app = file('src/App.jsx');
if (existsSync(app)) {
  let s = readFileSync(app, 'utf8');
  const fn = String.raw`function SectorRow({ sector, selected, maxValue, onSelect }) {
  const width = maxValue ? Math.max(4, (sector.tradingValueMillion / maxValue) * 100) : 0;
  const changeRate = sector.weightedChangeRate || sector.changeRate || 0;
  const stockSource = sector.topTradingValueStocks?.length ? sector.topTradingValueStocks : sector.topStocks?.length ? sector.topStocks : sector.stocks || [];
  const topStocks = [...stockSource]
    .sort((a, b) => ((b.tradeAmountMillion || b.tradingValueMillion || 0) - (a.tradeAmountMillion || a.tradingValueMillion || 0)) || ((b.volume || 0) - (a.volume || 0)))
    .slice(0, 5);

  return (
    <button className={"sector-row sector-card-block " + (selected ? "is-selected" : "")} onClick={() => onSelect(sector)}>
      <div className="sector-card-topline">
        <span className="sector-rank">{sector.rank}</span>
        <span className={"sector-change " + changeClass(changeRate)}>
          {changeRate >= 0 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
          {formatPercent(changeRate)}
        </span>
      </div>
      <div className="sector-card-titleline">
        <strong>{sector.name}</strong>
        <small>{sector.stockCount || 0}종목 · {sector.topStockName || topStocks[0]?.name || "집계 중"}</small>
      </div>
      <div className="sector-card-moneyline">
        <span>거래대금</span>
        <strong>{formatTradingValue(sector.tradingValueMillion)}</strong>
      </div>
      <div className="sector-card-bar"><i style={{ width: width + "%" }} /></div>
      <div className="sector-card-stocklist">
        {topStocks.map((stock, index) => {
          const money = stock.tradeAmountMillion ?? stock.tradingValueMillion ?? 0;
          return (
            <span key={stock.code || stock.name || index}>
              <em>{index + 1}</em>
              <strong title={stock.name}>{stock.name}</strong>
              <small>{formatTradingValue(money)}</small>
            </span>
          );
        })}
        {!topStocks.length && <p>상위 종목 집계 대기</p>}
      </div>
    </button>
  );
}`;

  const pattern = /function SectorRow\(\{ sector, selected, maxValue, onSelect \}\) \{[\s\S]*?\n\}\n\nfunction stockPeriodVolume/;
  if (pattern.test(s)) {
    s = s.replace(pattern, `${fn}\n\nfunction stockPeriodVolume`);
    writeFileSync(app, s, 'utf8');
    console.log('[card-ui] sector card block UI applied');
  } else {
    console.log('[card-ui] SectorRow pattern not found; skipped');
  }
}

const css = file('src/styles.css');
if (existsSync(css)) {
  let s = readFileSync(css, 'utf8');
  if (!s.includes('/* card-block-ui */')) {
    s += String.raw`

/* card-block-ui */
.sector-list{display:grid;grid-template-columns:1fr;gap:10px;padding:10px}.sector-row.sector-card-block{display:block;min-height:178px;margin-bottom:0;padding:14px;border:1px solid #e0e6df;border-radius:12px;background:#fff;box-shadow:0 10px 22px rgba(25,31,35,.045)}.sector-row.sector-card-block:hover,.sector-row.sector-card-block.is-selected{background:#f2f8f3;border-color:rgba(47,125,104,.34)}.sector-card-topline,.sector-card-moneyline,.sector-card-stocklist span{display:flex;align-items:center;justify-content:space-between;gap:10px}.sector-card-topline .sector-rank{width:auto;min-width:32px;padding:0 9px;border-radius:999px;background:#17202a;color:#fff}.sector-card-topline .sector-change{display:inline-flex;align-items:center;gap:3px}.sector-card-titleline{display:block;margin-top:10px}.sector-card-titleline strong{display:block;overflow:hidden;color:#151a1f;font-size:18px;font-weight:900;text-overflow:ellipsis;white-space:nowrap}.sector-card-titleline small{display:block;overflow:hidden;margin-top:4px;color:#6d767c;font-size:12px;font-weight:750;text-overflow:ellipsis;white-space:nowrap}.sector-card-moneyline{margin-top:12px}.sector-card-moneyline span{color:#737c82;font-size:12px;font-weight:800}.sector-card-moneyline strong{color:#151a1f;font-size:18px;font-weight:900}.sector-card-bar{height:6px;margin-top:8px;overflow:hidden;border-radius:999px;background:#e7ece7}.sector-card-bar i{display:block;height:100%;border-radius:inherit;background:#2f7d68}.sector-card-stocklist{display:grid;gap:5px;margin-top:12px}.sector-card-stocklist span{min-height:24px;padding:4px 6px;border-radius:7px;background:rgba(255,255,255,.72)}.sector-card-stocklist em{display:inline-grid;place-items:center;width:18px;height:18px;flex:0 0 18px;border-radius:999px;background:#edf2ed;color:#596366;font-size:11px;font-style:normal;font-weight:900}.sector-card-stocklist strong{overflow:hidden;flex:1;color:#1d2329;font-size:12px;font-weight:850;text-overflow:ellipsis;white-space:nowrap}.sector-card-stocklist small{flex:0 0 auto;color:#586266;font-size:12px;font-weight:850}.sector-card-stocklist p{margin:0;color:#7b8387;font-size:12px;font-weight:750}
`;
    writeFileSync(css, s, 'utf8');
    console.log('[card-ui] css appended');
  } else {
    console.log('[card-ui] css already present');
  }
}
