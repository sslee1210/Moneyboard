(() => {
  const PANEL_CLASS = "precision-watch-panel";
  const STYLE_ID = "precision-watch-panel-style";
  const POLL_MS = 10_000;
  const MAX_ITEMS = 10;

  let lastSignature = "";

  function escapeHtml(value = "") {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatTradingValue(millionWon = 0) {
    const value = Number(millionWon) || 0;
    if (value >= 100_000) return `${(value / 100_000).toFixed(2)}조`;
    if (value >= 100) return `${(value / 100).toFixed(2)}억`;
    return `${Math.round(value).toLocaleString("ko-KR")}백만`;
  }

  function formatPercent(value = 0) {
    const number = Number(value) || 0;
    const sign = number > 0 ? "+" : "";
    return `${sign}${number.toFixed(2)}%`;
  }

  async function fetchWatchlist() {
    const response = await fetch(`/api/precision-watchlist?limit=40&t=${Date.now()}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  function findAlertPanel() {
    return document.querySelector(".flow-alert-panel");
  }

  function createShell(parent) {
    let shell = parent.querySelector(`.${PANEL_CLASS}`);
    if (shell) return shell;

    shell = document.createElement("section");
    shell.className = PANEL_CLASS;
    shell.setAttribute("aria-label", "정밀감시 후보");

    const summary = parent.querySelector(".flow-alert-summary");
    const rule = parent.querySelector(".flow-alert-rule");
    if (summary) summary.insertAdjacentElement("afterend", shell);
    else if (rule) rule.insertAdjacentElement("afterend", shell);
    else parent.appendChild(shell);

    return shell;
  }

  function buildHtml(payload) {
    const items = (payload?.candidates || []).slice(0, MAX_ITEMS);
    const adapter = payload?.adapter || {};
    const providerText = adapter.enabled ? `${adapter.provider} 연결 준비` : "증권사 API 미연결";

    return `
      <div class="precision-watch-head">
        <div>
          <strong>정밀감시 후보</strong>
          <span>네이버 전체스캔 → API 후보 ${payload?.selectedCount || 0}종목</span>
        </div>
        <em>${escapeHtml(providerText)}</em>
      </div>
      <p class="precision-watch-note">증권사 WebSocket/NXT 어댑터 연결 시 이 후보만 구독하도록 설계</p>
      ${items.length ? `
        <ol class="precision-watch-list">
          ${items
            .map(
              (item) => `
                <li>
                  <a href="${escapeHtml(item.naverUrl || "#")}" target="_blank" rel="noreferrer">
                    <span class="precision-rank">${item.watchRank}</span>
                    <span class="precision-main">
                      <strong>${escapeHtml(item.name)}</strong>
                      <small>${escapeHtml(item.code)} · ${escapeHtml(item.market || "KRX")} · ${escapeHtml(item.sectorName || "섹터")}</small>
                    </span>
                    <span class="precision-values">
                      <b>${formatTradingValue(item.tradeAmountMillion)}</b>
                      <em class="${Number(item.changeRate) >= 0 ? "positive" : "negative"}">${formatPercent(item.changeRate)}</em>
                    </span>
                  </a>
                </li>
              `
            )
            .join("")}
        </ol>
      ` : `<div class="precision-watch-empty">후보 산정 대기 중</div>`}
    `;
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .precision-watch-panel {
        margin: 0 0 14px;
        padding: 12px;
        border: 1px solid rgba(37, 99, 235, 0.16);
        border-radius: 16px;
        background: linear-gradient(180deg, #eff6ff 0%, #ffffff 100%);
      }

      .precision-watch-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 8px;
      }

      .precision-watch-head div {
        display: grid;
        gap: 2px;
      }

      .precision-watch-head strong {
        font-size: 13px;
        color: #0f172a;
      }

      .precision-watch-head span,
      .precision-watch-head em,
      .precision-watch-note,
      .precision-watch-empty {
        font-size: 10px;
        font-style: normal;
        color: #64748b;
      }

      .precision-watch-head em {
        padding: 3px 7px;
        border-radius: 999px;
        background: rgba(37, 99, 235, 0.1);
        color: #1d4ed8;
        white-space: nowrap;
      }

      .precision-watch-note {
        margin: 0 0 10px;
      }

      .precision-watch-list {
        display: grid;
        gap: 7px;
        margin: 0;
        padding: 0;
        list-style: none;
      }

      .precision-watch-list a {
        display: grid;
        grid-template-columns: 24px minmax(0, 1fr) auto;
        gap: 8px;
        align-items: center;
        padding: 8px 9px;
        border: 1px solid rgba(15, 23, 42, 0.08);
        border-radius: 12px;
        background: #fff;
        color: inherit;
        text-decoration: none;
      }

      .precision-rank {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border-radius: 999px;
        background: #dbeafe;
        color: #1d4ed8;
        font-size: 11px;
        font-weight: 800;
      }

      .precision-main,
      .precision-values {
        display: grid;
        gap: 2px;
        min-width: 0;
      }

      .precision-main strong {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
      }

      .precision-main small,
      .precision-values em {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 10px;
        font-style: normal;
        color: #64748b;
      }

      .precision-values {
        justify-items: end;
        text-align: right;
      }

      .precision-values b {
        font-size: 12px;
        color: #0f172a;
      }
    `;
    document.head.appendChild(style);
  }

  async function render() {
    const panel = findAlertPanel();
    if (!panel) return;

    try {
      const payload = await fetchWatchlist();
      const signature = JSON.stringify((payload.candidates || []).slice(0, MAX_ITEMS).map((item) => [item.code, item.tradeAmountMillion, item.score]));
      if (signature === lastSignature) return;
      lastSignature = signature;
      createShell(panel).innerHTML = buildHtml(payload);
    } catch {
      // The right alert log must keep working even when the watchlist endpoint is temporarily unavailable.
    }
  }

  function start() {
    injectStyle();
    render();
    window.setInterval(render, POLL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
