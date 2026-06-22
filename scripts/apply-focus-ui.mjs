import { readFileSync, writeFileSync } from "node:fs";

function ensureAfter(source, anchorPattern, insertText, label) {
  if (source.includes(insertText.trim())) return source;
  const match = source.match(anchorPattern);
  if (!match) throw new Error(`Cannot patch ${label}: anchor not found`);
  return source.replace(match[0], `${match[0]}\n${insertText}`);
}

function replaceLoose(source, pattern, replacement, label) {
  if (typeof pattern === "string") {
    if (source.includes(replacement)) return source;
    if (!source.includes(pattern)) throw new Error(`Cannot patch ${label}: target text not found`);
    return source.replace(pattern, replacement);
  }
  if (pattern.test(source)) return source.replace(pattern, replacement);
  return source;
}

function patchApp() {
  const path = "src/App.jsx";
  let source = readFileSync(path, "utf8");

  source = ensureAfter(
    source,
    /const localSnapshotKey = "moneyboard:last-market-snapshot";/,
    "const FOCUS_SECTOR_COUNT = 8;\nconst FOCUS_STOCKS_PER_SECTOR = 5;",
    "focus constants"
  );

  source = source.replace(/sectors\.slice\(0,\s*12\)/g, "sectors.slice(0, FOCUS_SECTOR_COUNT)");
  source = source.replace(/\.slice\(0,\s*20\)/g, ".slice(0, FOCUS_STOCKS_PER_SECTOR)");

  source = source.replace(
    /const topTwelve = rankedSectors\.slice\(0,\s*12\);\s*\n\s*if \(!keyword\) return topTwelve;/,
    "const topFocusSectors = rankedSectors.slice(0, FOCUS_SECTOR_COUNT);\n    if (!keyword) return topFocusSectors;"
  );
  source = source.replace(/\.slice\(0,\s*12\);\s*\n\s*}, \[rankedSectors, query\]\);/, ".slice(0, FOCUS_SECTOR_COUNT);\n  }, [rankedSectors, query]);");

  source = source.replace(/거래대금 랭킹 섹터\s*12/g, "거래대금 랭킹 섹터 {FOCUS_SECTOR_COUNT}");
  source = source.replace(/className="sector-grid-12"/g, 'className="sector-grid-8"');

  source = source.replace(
    /<h2>\{sector\?\.name \|\| "선택 섹터"\} 거래대금 상위 종목<\/h2>/g,
    '<h2>{sector?.name || "선택 섹터"} 거래대금 상위 {FOCUS_STOCKS_PER_SECTOR}종목</h2>'
  );

  source = source.replace(
    /섹터\/종목 데이터는 네이버 금융 업종별 시세를 기반으로 수집하며, 거래대금 컬럼은 현재가×거래량 검증 후 표시합니다\.\s*\n\s*로컬 서버는 라이브 동기화, 브라우저는 직전 정상 스냅샷을 즉시 표시한 뒤 최신 데이터로 교체합니다\./,
    "섹터/종목 목록은 네이버 금융 업종별 시세를 기반으로 수집하고, 거래량/거래대금 숫자는 KIS REST/WebSocket으로 수신한 focus-40 종목만 표시합니다.\n        로컬 서버는 상위 섹터 8개 × 섹터별 상위 5종목을 우선 검증하고 브라우저는 최신 빌드 화면으로 교체합니다."
  );

  writeFileSync(path, source, "utf8");
}

function patchCss() {
  const path = "src/sector-stock-list.css";
  let source = readFileSync(path, "utf8");
  source = source.replace(
    "/* Final Moneyboard layout: readable 4 x 3 trading-value dashboard. */",
    "/* Focus-40 Moneyboard layout: readable 4 x 2 trading-value dashboard. */"
  );
  source = source.replace(/\.sector-grid-12/g, ".sector-grid-8");
  writeFileSync(path, source, "utf8");
}

patchApp();
patchCss();
console.log("Applied focus-40 UI patch: 8 sector cards, 5 selected stocks, KIS-only numeric policy.");
