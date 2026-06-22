import { readFileSync, writeFileSync } from "node:fs";

function replaceRequired(source, from, to, label) {
  if (source.includes(to)) return source;
  if (!source.includes(from)) {
    throw new Error(`Cannot patch ${label}: target text not found`);
  }
  return source.replace(from, to);
}

function patchApp() {
  const path = "src/App.jsx";
  let source = readFileSync(path, "utf8");

  source = replaceRequired(
    source,
    'const localSnapshotKey = "moneyboard:last-market-snapshot";\n',
    'const localSnapshotKey = "moneyboard:last-market-snapshot";\nconst FOCUS_SECTOR_COUNT = 8;\nconst FOCUS_STOCKS_PER_SECTOR = 5;\n',
    "focus constants"
  );

  source = replaceRequired(
    source,
    "  const chartData = sectors.slice(0, 12).map((sector) => ({",
    "  const chartData = sectors.slice(0, FOCUS_SECTOR_COUNT).map((sector) => ({",
    "leader chart focus slice"
  );

  source = replaceRequired(
    source,
    "    return sortStocksByTradingValue(sectorStockSource(sector, activeDetail)).slice(0, 20);",
    "    return sortStocksByTradingValue(sectorStockSource(sector, activeDetail)).slice(0, FOCUS_STOCKS_PER_SECTOR);",
    "selected stock focus slice"
  );

  source = replaceRequired(
    source,
    "          <h2>{sector?.name || \"선택 섹터\"} 거래대금 상위 종목</h2>",
    "          <h2>{sector?.name || \"선택 섹터\"} 거래대금 상위 {FOCUS_STOCKS_PER_SECTOR}종목</h2>",
    "selected stock heading"
  );

  source = replaceRequired(
    source,
    `  const filteredSectors = useMemo(() => {\n    const keyword = query.trim().toLowerCase();\n    const topTwelve = rankedSectors.slice(0, 12);\n    if (!keyword) return topTwelve;\n    return rankedSectors\n      .filter((sector) => {\n        const stockNames = [\n          ...(sector.stocks || []),\n          ...(sector.topTradingValueStocks || []),\n          ...(sector.topStocks || []),\n        ]\n          .map((stock) => stock.name)\n          .join(" ");\n        return \`${"${sector.name} ${stockNames}"}\`.toLowerCase().includes(keyword);\n      })\n      .slice(0, 12);\n  }, [rankedSectors, query]);`,
    `  const filteredSectors = useMemo(() => {\n    const keyword = query.trim().toLowerCase();\n    const topFocusSectors = rankedSectors.slice(0, FOCUS_SECTOR_COUNT);\n    if (!keyword) return topFocusSectors;\n    return rankedSectors\n      .filter((sector) => {\n        const stockNames = [\n          ...(sector.stocks || []),\n          ...(sector.topTradingValueStocks || []),\n          ...(sector.topStocks || []),\n        ]\n          .map((stock) => stock.name)\n          .join(" ");\n        return \`${"${sector.name} ${stockNames}"}\`.toLowerCase().includes(keyword);\n      })\n      .slice(0, FOCUS_SECTOR_COUNT);\n  }, [rankedSectors, query]);`,
    "focus sector filter"
  );

  source = replaceRequired(
    source,
    "              <h2>거래대금 랭킹 섹터 12</h2>",
    "              <h2>거래대금 랭킹 섹터 {FOCUS_SECTOR_COUNT}</h2>",
    "ranking heading"
  );

  source = replaceRequired(
    source,
    '        <div className="sector-grid-12">',
    '        <div className="sector-grid-8">',
    "sector grid class"
  );

  source = replaceRequired(
    source,
    `        섹터/종목 데이터는 네이버 금융 업종별 시세를 기반으로 수집하며, 거래대금 컬럼은 현재가×거래량 검증 후 표시합니다.\n        로컬 서버는 라이브 동기화, 브라우저는 직전 정상 스냅샷을 즉시 표시한 뒤 최신 데이터로 교체합니다.`,
    `        섹터/종목 목록은 네이버 금융 업종별 시세를 기반으로 수집하고, 거래량/거래대금 숫자는 KIS REST/WebSocket으로 수신한 focus-40 종목만 표시합니다.\n        로컬 서버는 상위 섹터 8개 × 섹터별 상위 5종목을 우선 검증하고 브라우저는 최신 빌드 화면으로 교체합니다.`,
    "footer policy"
  );

  writeFileSync(path, source, "utf8");
}

function patchCss() {
  const path = "src/sector-stock-list.css";
  let source = readFileSync(path, "utf8");
  source = source.replace("/* Final Moneyboard layout: readable 4 x 3 trading-value dashboard. */", "/* Focus-40 Moneyboard layout: readable 4 x 2 trading-value dashboard. */");
  source = source.replace(/\.sector-grid-12/g, ".sector-grid-8");
  writeFileSync(path, source, "utf8");
}

patchApp();
patchCss();
console.log("Applied focus-40 UI patch: 8 sector cards, 5 selected stocks, KIS-only numeric policy.");
