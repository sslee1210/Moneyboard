const DEFAULT_WATCH_LIMIT = Number(process.env.PRECISION_WATCH_LIMIT || 40);
const DEFAULT_SOURCE_TOP_SECTORS = Number(process.env.PRECISION_SOURCE_TOP_SECTORS || 12);
const DEFAULT_MIN_TRADE_AMOUNT_MILLION = Number(process.env.PRECISION_MIN_TRADE_AMOUNT_MILLION || 0);

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeTradeAmount(value) {
  const tradeAmount = safeNumber(value);
  if (tradeAmount <= 0) return 0;
  return Math.log10(tradeAmount + 10) * 22;
}

function buildReasonTags(stock, sector, sectorRank) {
  const tags = [];
  const tradeAmountMillion = safeNumber(stock.tradeAmountMillion);
  const changeRate = safeNumber(stock.changeRate);

  if (sectorRank <= 8) tags.push(`섹터 ${sectorRank}위`);
  if (tradeAmountMillion >= 100_000) tags.push("거래대금 1조+");
  else if (tradeAmountMillion >= 10_000) tags.push("거래대금 1천억+");
  else if (tradeAmountMillion >= 1_000) tags.push("거래대금 100억+");
  if (Math.abs(changeRate) >= 7) tags.push("급등락 7%+");
  if (stock.direction === "up") tags.push("상승 흐름");
  if (stock.direction === "down") tags.push("하락 압력");

  return tags.slice(0, 4);
}

function scoreCandidate(stock, sector, sectorRank, stockRank) {
  const tradeScore = normalizeTradeAmount(stock.tradeAmountMillion);
  const sectorScore = Math.max(0, 30 - sectorRank * 1.8);
  const stockRankScore = Math.max(0, 18 - stockRank * 2.4);
  const changeScore = Math.min(Math.abs(safeNumber(stock.changeRate)) * 1.5, 18);
  const breadthScore = safeNumber(sector.tradingValueMillion) > 0 ? 8 : 0;
  return tradeScore + sectorScore + stockRankScore + changeScore + breadthScore;
}

function candidateKey(stock) {
  return stock?.code || `${stock?.name || "unknown"}:${stock?.market || ""}`;
}

export function buildPrecisionWatchlist(snapshot, options = {}) {
  const watchLimit = Math.max(1, Number(options.limit || DEFAULT_WATCH_LIMIT));
  const sourceTopSectors = Math.max(1, Number(options.sourceTopSectors || DEFAULT_SOURCE_TOP_SECTORS));
  const minTradeAmountMillion = Math.max(0, Number(options.minTradeAmountMillion ?? DEFAULT_MIN_TRADE_AMOUNT_MILLION));
  const byCode = new Map();

  (snapshot?.sectors || []).slice(0, sourceTopSectors).forEach((sector, sectorIndex) => {
    const sectorRank = sectorIndex + 1;
    (sector.topStocks || []).forEach((stock, stockIndex) => {
      if (!stock?.code || !stock?.name) return;
      const tradeAmountMillion = safeNumber(stock.tradeAmountMillion);
      if (tradeAmountMillion < minTradeAmountMillion) return;

      const score = scoreCandidate(stock, sector, sectorRank, stockIndex + 1);
      const key = candidateKey(stock);
      const current = byCode.get(key);
      const candidate = {
        code: stock.code,
        name: stock.name,
        market: stock.market || "KRX",
        sectorId: sector.id,
        sectorName: sector.name,
        sectorRank,
        stockRank: stockIndex + 1,
        price: safeNumber(stock.price),
        changeRate: safeNumber(stock.changeRate),
        direction: stock.direction || "flat",
        tradeAmountMillion,
        naverUrl: stock.naverUrl,
        score: Number(score.toFixed(2)),
        reasonTags: buildReasonTags(stock, sector, sectorRank)
      };

      if (!current || candidate.score > current.score || candidate.tradeAmountMillion > current.tradeAmountMillion) {
        byCode.set(key, candidate);
      }
    });
  });

  const candidates = [...byCode.values()]
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return right.tradeAmountMillion - left.tradeAmountMillion;
    })
    .slice(0, watchLimit)
    .map((item, index) => ({ ...item, watchRank: index + 1 }));

  return {
    updatedAt: new Date().toISOString(),
    sourceUpdatedAt: snapshot?.updatedAt || null,
    mode: "broad-scan-selected-watchlist",
    broadScanProvider: snapshot?.provider || "Naver Finance",
    precisionProvider: "broker-api-adapter-pending",
    marketScope: "KRX broad scan; NXT can be attached only through a broker/NXT market adapter",
    watchLimit,
    sourceTopSectors,
    minTradeAmountMillion,
    selectedCount: candidates.length,
    candidates,
    adapter: getPrecisionWatchAdapterStatus()
  };
}

export function getPrecisionWatchAdapterStatus() {
  const provider = process.env.PRECISION_API_PROVIDER || "none";
  const enabled = process.env.PRECISION_API_ENABLED === "true";
  const market = process.env.PRECISION_MARKET_SCOPE || "KRX_SELECTED";

  return {
    enabled,
    provider,
    market,
    websocket: enabled ? "ready-for-adapter" : "not-configured",
    restPolling: enabled ? "fallback-only" : "not-configured",
    note: enabled
      ? "Only selected watchlist candidates should be subscribed by the broker adapter."
      : "Set PRECISION_API_ENABLED=true and configure a broker adapter to replace candidate-only mode."
  };
}
