(() => {
  const PANEL_ID = "moneyboard-flow-alert-sidecar";
  const STYLE_ID = "moneyboard-flow-alert-sidecar-style";
  const API_PATH = "/api/sectors";
  const POLL_MS = 3000;
  const FLOW_THRESHOLD_MILLION = 1000;
  const WINDOWS = [
    { id: "1m", label: "1분봉", durationMs: 60_000 },
    { id: "3m", label: "3분봉", durationMs: 180_000 }
  ];
  const COOLDOWN_MS = 180_000;
  const SAMPLE_KEEP_MS = 185_000;
  const ALERT_KEEP_MS = 10 * 60_000;
  const MAX_ALERTS = 40;
  const MAX_SUMMARY_ITEMS = 10;

  const samplesByCode = new Map();
  const cooldownBySignal = new Map();
  const summaryByCode = new Map();
  let alerts = [];
  let polling = false;
  let lastRenderSignature = "";

  const currencyFormatter = new Intl.NumberFormat("ko-KR");
  const percentFormatter = new Intl.NumberFormat("ko-KR", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  });

  function escapeHtml(value = "") {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatTradingValue(millionWon = 0) {
    const value = Number(millionWon) || 0;
    if (value >= 100_000) return `${percentFormatter.format(value / 100_000)}조`;
    if (value >= 100) return `${percentFormatter.format(value / 100)}억`;
    return `${currencyFormatter.format(Math.round(value))}백만`;
  }

  function formatPercent(value = 0) {
    const number = Number(value) || 0;
    const sign = number > 0 ? "+" : "";
    return `${sign}${percentFormatter.format(number)}%`;
  }

  function formatTime(value) {
    try {
      return new Intl.DateTimeFormat("ko-KR", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      }).format(new Date(value));
    } catch {
      return "--:--:--";
    }
  }

  function changeClass(value = 0) {
    const number = Number(value) || 0;
    if (number > 0) return "positive";
    if (number < 0) return "negative";
    return "neutral";
  }

  function collectStocks(snapshot) {
    const byCode = new Map();

    (snapshot?.sectors || []).forEach((sector, sectorIndex) => {
      (sector.topStocks || []).forEach((stock) => {
        if (!stock?.code) return;
        const tradeAmountMillion = Number(stock.tradeAmountMillion);
        if (!Number.isFinite(tradeAmountMillion)) return;

        const next = {
          code: stock.code,
          name: stock.name || stock.code,
          market: stock.market || "",
          price: stock.price,
          changeRate: stock.changeRate,
          tradeAmountMillion,
          sectorName: sector.name || "섹터 확인 중",
          sectorRank: sector.rank || sectorIndex + 1,
          naverUrl: stock.naverUrl || `https://finance.naver.com/item/main.naver?code=${stock.code}`
        };

        const current = byCode.get(stock.code);
        if (!current || next.tradeAmountMillion > current.tradeAmountMillion) {
          byCode.set(stock.code, next);
        }
      });
    });

    return [...byCode.values()];
  }

  function updateSummary(alert) {
    const current = summaryByCode.get(alert.code) || {
      code: alert.code,
      name: alert.name,
      market: alert.market,
      naverUrl: alert.naverUrl,
      count: 0,
      oneMinuteCount: 0,
      threeMinuteCount: 0,
      lastSeenAt: 0
    };

    current.name = alert.name;
    current.market = alert.market;
    current.naverUrl = alert.naverUrl;
    current.count += 1;
    current.oneMinuteCount += alert.windowLabel.includes("1") ? 1 : 0;
    current.threeMinuteCount += alert.windowLabel.includes("3") ? 1 : 0;
    current.lastWindowLabel = alert.windowLabel;
    current.lastTriggeredAt = alert.triggeredAt;
    current.lastDeltaMillion = alert.deltaMillion;
    current.lastElapsedSeconds = alert.elapsedSeconds;
    current.lastSector = alert.sectorName;
    current.lastChangeRate = alert.changeRate;
    current.lastSeenAt = Date.now();
    summaryByCode.set(alert.code, current);
  }

  function detectAlerts(snapshot) {
    const now = Date.now();
    const stocks = collectStocks(snapshot);
    const activeCodes = new Set(stocks.map((stock) => stock.code));
    const newAlerts = [];

    stocks.forEach((stock) => {
      const currentValue = stock.tradeAmountMillion;
      const existingSamples = samplesByCode.get(stock.code) || [];
      const lastSample = existingSamples[existingSamples.length - 1];
      const resetSamples = lastSample && currentValue < lastSample.value;
      const nextSamples = resetSamples
        ? []
        : existingSamples.filter((sample) => now - sample.ts <= SAMPLE_KEEP_MS);

      if (!lastSample || resetSamples || currentValue !== lastSample.value || now - lastSample.ts >= 1500) {
        nextSamples.push({ ts: now, value: currentValue });
      }

      samplesByCode.set(stock.code, nextSamples);
      if (nextSamples.length < 2) return;

      WINDOWS.forEach((windowItem) => {
        const windowSamples = nextSamples.filter((sample) => now - sample.ts <= windowItem.durationMs);
        if (windowSamples.length < 2) return;

        const base = windowSamples[0];
        const elapsedMs = now - base.ts;
        const deltaMillion = currentValue - base.value;
        if (elapsedMs <= 0 || deltaMillion < FLOW_THRESHOLD_MILLION) return;

        const signalKey = `${stock.code}:${windowItem.id}`;
        const lastAlertAt = cooldownBySignal.get(signalKey) || 0;
        if (now - lastAlertAt < COOLDOWN_MS) return;

        cooldownBySignal.set(signalKey, now);
        const alert = {
          id: `${signalKey}:${now}`,
          code: stock.code,
          name: stock.name,
          market: stock.market,
          price: stock.price,
          changeRate: stock.changeRate,
          sectorName: stock.sectorName,
          sectorRank: stock.sectorRank,
          naverUrl: stock.naverUrl,
          windowLabel: windowItem.label,
          deltaMillion,
          elapsedSeconds: Math.max(1, Math.round(elapsedMs / 1000)),
          triggeredAt: new Date(now).toISOString()
        };

        updateSummary(alert);
        newAlerts.push(alert);
      });
    });

    [...samplesByCode.keys()].forEach((code) => {
      if (!activeCodes.has(code)) samplesByCode.delete(code);
    });

    if (newAlerts.length) {
      alerts = [...newAlerts.sort((a, b) => b.deltaMillion - a.deltaMillion), ...alerts]
        .filter((alert) => now - new Date(alert.triggeredAt).getTime() <= ALERT_KEEP_MS)
        .slice(0, MAX_ALERTS);
    } else {
      alerts = alerts.filter((alert) => now - new Date(alert.triggeredAt).getTime() <= ALERT_KEEP_MS);
    }
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      body.has-flow-sidecar {
        --flow-sidecar-width: 370px;
      }

      #${PANEL_ID} {
        position: fixed;
        top: 18px;
        right: 18px;
        z-index: 9999;
        width: min(370px, calc(100vw - 28px));
        max-height: calc(100vh - 36px);
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 16px;
        border: 1px solid rgba(15, 23, 42, 0.12);
        border-radius: 22px;
        background: rgba(255, 255, 255, 0.96);
        box-shadow: 0 24px 70px rgba(15, 23, 42, 0.18);
        backdrop-filter: blur(18px);
        color: #0f172a;
        font-family: inherit;
      }

      @media (min-width: 1320px) {
        body.has-flow-sidecar main {
          max-width: calc(100vw - var(--flow-sidecar-width) - 64px);
          margin-left: 24px;
          margin-right: calc(var(--flow-sidecar-width) + 34px);
        }
      }

      @media (max-width: 1180px) {
        #${PANEL_ID} {
          position: static;
          width: auto;
          max-height: none;
          margin: 16px;
        }
      }

      .flow-sidecar-head {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: flex-start;
      }

      .flow-sidecar-head span {
        display: block;
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.08em;
        color: #64748b;
      }

      .flow-sidecar-head strong {
        display: block;
        margin-top: 3px;
        font-size: 18px;
        letter-spacing: -0.04em;
      }

      .flow-sidecar-rule {
        text-align: right;
        font-size: 12px;
        color: #64748b;
        line-height: 1.45;
      }

      .flow-sidecar-rule b {
        display: block;
        font-size: 14px;
        color: #dc2626;
      }

      .flow-summary-box,
      .flow-log-box {
        border: 1px solid rgba(15, 23, 42, 0.08);
        border-radius: 18px;
        background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%);
        overflow: hidden;
      }

      .flow-box-title {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        padding: 11px 12px;
        border-bottom: 1px solid rgba(15, 23, 42, 0.07);
      }

      .flow-box-title strong {
        font-size: 13px;
      }

      .flow-box-title span {
        font-size: 11px;
        color: #64748b;
      }

      .flow-summary-list,
      .flow-log-list {
        display: flex;
        flex-direction: column;
        max-height: 235px;
        overflow-y: auto;
      }

      .flow-summary-list a,
      .flow-log-item {
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: 9px;
        align-items: center;
        padding: 10px 12px;
        border-bottom: 1px solid rgba(15, 23, 42, 0.06);
        color: inherit;
        text-decoration: none;
      }

      .flow-summary-list a:hover,
      .flow-log-item:hover {
        background: #f1f5f9;
      }

      .flow-rank,
      .flow-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 30px;
        height: 28px;
        padding: 0 8px;
        border-radius: 999px;
        background: #0f172a;
        color: #fff;
        font-size: 11px;
        font-weight: 800;
      }

      .flow-main strong {
        display: block;
        max-width: 132px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
      }

      .flow-main em,
      .flow-main small {
        display: block;
        margin-top: 2px;
        font-style: normal;
        font-size: 11px;
        color: #64748b;
      }

      .flow-count,
      .flow-money {
        text-align: right;
      }

      .flow-count b,
      .flow-money strong {
        display: block;
        font-size: 13px;
        color: #dc2626;
      }

      .flow-count small,
      .flow-money span,
      .flow-money time {
        display: block;
        margin-top: 2px;
        font-size: 11px;
        color: #64748b;
      }

      .flow-empty {
        padding: 18px 12px;
        text-align: center;
        font-size: 12px;
        color: #94a3b8;
      }

      .positive { color: #16a34a; }
      .negative { color: #dc2626; }
      .neutral { color: #64748b; }
    `;
    document.head.appendChild(style);
  }

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;

    panel = document.createElement("aside");
    panel.id = PANEL_ID;
    panel.setAttribute("aria-label", "1분봉 3분봉 거래대금 유입 알림");
    document.body.appendChild(panel);
    document.body.classList.add("has-flow-sidecar");
    return panel;
  }

  function summaryItems() {
    return [...summaryByCode.values()]
      .sort((left, right) => {
        if (right.count !== left.count) return right.count - left.count;
        return right.lastSeenAt - left.lastSeenAt;
      })
      .slice(0, MAX_SUMMARY_ITEMS);
  }

  function buildSummaryHtml(items) {
    if (!items.length) {
      return `<div class="flow-empty">아직 감지된 종목이 없습니다.</div>`;
    }

    return `
      <div class="flow-summary-list">
        ${items
          .map(
            (item, index) => `
              <a href="${escapeHtml(item.naverUrl)}" target="_blank" rel="noreferrer">
                <span class="flow-rank">${index + 1}</span>
                <span class="flow-main">
                  <strong>${escapeHtml(item.name)}</strong>
                  <em>${escapeHtml(item.code)}${item.market ? ` · ${escapeHtml(item.market)}` : ""}</em>
                  <small>${escapeHtml(item.lastSector || "섹터 확인 중")}</small>
                </span>
                <span class="flow-count">
                  <b>${item.count}회</b>
                  <small>1분 ${item.oneMinuteCount} · 3분 ${item.threeMinuteCount}</small>
                  <small>${formatTradingValue(item.lastDeltaMillion)} · ${formatTime(item.lastTriggeredAt)}</small>
                </span>
              </a>
            `
          )
          .join("")}
      </div>
    `;
  }

  function buildAlertHtml(alertItems) {
    if (!alertItems.length) {
      return `<div class="flow-empty">10억 이상 유입 감지 대기 중입니다.</div>`;
    }

    return `
      <div class="flow-log-list">
        ${alertItems
          .map(
            (alert) => `
              <a class="flow-log-item" href="${escapeHtml(alert.naverUrl)}" target="_blank" rel="noreferrer">
                <span class="flow-badge">${escapeHtml(alert.windowLabel)}</span>
                <span class="flow-main">
                  <strong>${escapeHtml(alert.name)}</strong>
                  <em>${escapeHtml(alert.code)}${alert.market ? ` · ${escapeHtml(alert.market)}` : ""}</em>
                  <small>${escapeHtml(alert.sectorName || "섹터 확인 중")} · <span class="${changeClass(alert.changeRate)}">${formatPercent(alert.changeRate)}</span></small>
                </span>
                <span class="flow-money">
                  <strong>${formatTradingValue(alert.deltaMillion)}</strong>
                  <span>${alert.elapsedSeconds}초 누적</span>
                  <time>${formatTime(alert.triggeredAt)}</time>
                </span>
              </a>
            `
          )
          .join("")}
      </div>
    `;
  }

  function render() {
    const items = summaryItems();
    const signature = JSON.stringify({
      summary: items.map((item) => [item.code, item.count, item.oneMinuteCount, item.threeMinuteCount, item.lastDeltaMillion, item.lastTriggeredAt]),
      alerts: alerts.map((alert) => alert.id)
    });

    if (signature === lastRenderSignature) return;
    lastRenderSignature = signature;

    const panel = ensurePanel();
    panel.innerHTML = `
      <div class="flow-sidecar-head">
        <div>
          <span>FLOW ALERT</span>
          <strong>실시간 10억 유입</strong>
        </div>
        <div class="flow-sidecar-rule">
          <b>1분/3분</b>
          누적 거래대금 증가분 기준
        </div>
      </div>
      <section class="flow-summary-box">
        <div class="flow-box-title">
          <strong>종목별 감지 횟수</strong>
          <span>현재 세션 · ${items.length}종목</span>
        </div>
        ${buildSummaryHtml(items)}
      </section>
      <section class="flow-log-box">
        <div class="flow-box-title">
          <strong>실시간 알림 로그</strong>
          <span>최근 ${alerts.length}건</span>
        </div>
        ${buildAlertHtml(alerts)}
      </section>
    `;
  }

  async function poll() {
    if (polling) return;
    polling = true;

    try {
      const response = await fetch(`${API_PATH}?flowAlertT=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const snapshot = await response.json();
      detectAlerts(snapshot);
      render();
    } catch {
      render();
    } finally {
      polling = false;
    }
  }

  function boot() {
    injectStyle();
    ensurePanel();
    render();
    poll();
    window.setInterval(poll, POLL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
