(() => {
  const STORAGE_KEY = "moneyboard.flowAlertSummary.v2";
  const SUMMARY_CLASS = "flow-alert-summary";
  const MAX_SEEN_KEYS = 800;
  const MAX_SUMMARY_ITEMS = 8;
  const RENDER_INTERVAL_MS = 3000;

  let lastRenderSignature = "";

  function loadState() {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "{}");
      return {
        seen: Array.isArray(parsed.seen) ? parsed.seen : [],
        items: parsed.items && typeof parsed.items === "object" ? parsed.items : {}
      };
    } catch {
      return { seen: [], items: {} };
    }
  }

  function saveState(state) {
    try {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          seen: state.seen.slice(-MAX_SEEN_KEYS),
          items: state.items
        })
      );
    } catch {
      // Session persistence is optional. Rendering must continue when storage is blocked.
    }
  }

  function escapeHtml(value = "") {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function text(parent, selector) {
    return parent.querySelector(selector)?.textContent?.trim() || "";
  }

  function parseAlert(alertElement) {
    const name = text(alertElement, ".flow-alert-name-row strong");
    const identity = text(alertElement, ".flow-alert-name-row small");
    const [code = "", market = ""] = identity.split("·").map((part) => part.trim());
    const windowLabel = text(alertElement, ".flow-alert-badge");
    const triggeredTime = text(alertElement, "time");
    const sector = text(alertElement, ".flow-alert-meta span:first-child");
    const changeRate = text(alertElement, ".flow-alert-meta .positive, .flow-alert-meta .negative, .flow-alert-meta .neutral");
    const money = text(alertElement, ".flow-alert-money strong");
    const elapsed = text(alertElement, ".flow-alert-money span");
    const href = alertElement.getAttribute("href") || "#";

    if (!code || !name || !windowLabel || !triggeredTime || !money) return null;

    return {
      key: `${code}|${windowLabel}|${triggeredTime}|${money}|${elapsed}`,
      code,
      name,
      market,
      windowLabel,
      triggeredTime,
      sector,
      changeRate,
      money,
      elapsed,
      href
    };
  }

  function scanAlerts() {
    const alertElements = [...document.querySelectorAll(".flow-alert-panel .flow-alert-item")];
    const state = loadState();
    const seenSet = new Set(state.seen);
    let changed = false;

    alertElements.forEach((alertElement) => {
      const alert = parseAlert(alertElement);
      if (!alert || seenSet.has(alert.key)) return;

      seenSet.add(alert.key);
      const current = state.items[alert.code] || {
        code: alert.code,
        name: alert.name,
        market: alert.market,
        href: alert.href,
        count: 0,
        oneMinuteCount: 0,
        threeMinuteCount: 0,
        lastSeenAt: 0
      };

      current.name = alert.name;
      current.market = alert.market;
      current.href = alert.href;
      current.count += 1;
      current.oneMinuteCount += alert.windowLabel.includes("1") ? 1 : 0;
      current.threeMinuteCount += alert.windowLabel.includes("3") ? 1 : 0;
      current.lastWindowLabel = alert.windowLabel;
      current.lastTriggeredTime = alert.triggeredTime;
      current.lastMoney = alert.money;
      current.lastElapsed = alert.elapsed;
      current.lastSector = alert.sector;
      current.lastChangeRate = alert.changeRate;
      current.lastSeenAt = Date.now();
      state.items[alert.code] = current;
      changed = true;
    });

    if (changed) {
      state.seen = [...seenSet].slice(-MAX_SEEN_KEYS);
      saveState(state);
    }

    return state;
  }

  function createSummaryShell(panel) {
    let summary = panel.querySelector(`.${SUMMARY_CLASS}`);
    if (summary) return summary;

    summary = document.createElement("section");
    summary.className = SUMMARY_CLASS;
    summary.setAttribute("aria-label", "종목별 신호 감지 횟수");

    const rule = panel.querySelector(".flow-alert-rule");
    if (rule) {
      rule.insertAdjacentElement("afterend", summary);
    } else {
      panel.appendChild(summary);
    }

    return summary;
  }

  function buildSummaryHtml(items) {
    if (!items.length) {
      return `
        <div class="flow-summary-head">
          <strong>종목별 감지 횟수</strong>
          <span>현재 세션</span>
        </div>
        <div class="flow-summary-empty">아직 취합된 종목이 없습니다.</div>
      `;
    }

    return `
      <div class="flow-summary-head">
        <strong>종목별 감지 횟수</strong>
        <span>현재 세션 · ${items.length}종목</span>
      </div>
      <ol class="flow-summary-list">
        ${items
          .map(
            (item, index) => `
              <li>
                <a href="${escapeHtml(item.href)}" target="_blank" rel="noreferrer">
                  <span class="flow-summary-rank">${index + 1}</span>
                  <span class="flow-summary-main">
                    <strong>${escapeHtml(item.name)}</strong>
                    <em>${escapeHtml(item.code)}${item.market ? ` · ${escapeHtml(item.market)}` : ""}</em>
                    <small>${escapeHtml(item.lastSector || "섹터 확인 중")}</small>
                  </span>
                  <span class="flow-summary-count">
                    <b>${item.count}회</b>
                    <small>1분 ${item.oneMinuteCount} · 3분 ${item.threeMinuteCount}</small>
                    <em>${escapeHtml(item.lastMoney || "최근 유입")} · ${escapeHtml(item.lastTriggeredTime || "--:--")}</em>
                  </span>
                </a>
              </li>
            `
          )
          .join("")}
      </ol>
    `;
  }

  function renderSummary() {
    const panel = document.querySelector(".flow-alert-panel");
    if (!panel) return;

    const state = scanAlerts();
    const items = Object.values(state.items)
      .sort((left, right) => {
        if (right.count !== left.count) return right.count - left.count;
        return right.lastSeenAt - left.lastSeenAt;
      })
      .slice(0, MAX_SUMMARY_ITEMS);

    const signature = JSON.stringify(
      items.map((item) => [
        item.code,
        item.count,
        item.oneMinuteCount,
        item.threeMinuteCount,
        item.lastMoney,
        item.lastTriggeredTime
      ])
    );

    if (signature === lastRenderSignature) return;
    lastRenderSignature = signature;

    createSummaryShell(panel).innerHTML = buildSummaryHtml(items);
  }

  function injectStyle() {
    if (document.getElementById("flow-alert-summary-style")) return;

    const style = document.createElement("style");
    style.id = "flow-alert-summary-style";
    style.textContent = `
      .flow-alert-summary {
        margin: 12px 0 14px;
        padding: 12px;
        border: 1px solid rgba(18, 27, 52, 0.09);
        border-radius: 16px;
        background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.75);
      }

      .flow-summary-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 10px;
      }

      .flow-summary-head strong {
        font-size: 13px;
        letter-spacing: -0.02em;
        color: #111827;
      }

      .flow-summary-head span,
      .flow-summary-empty {
        font-size: 11px;
        color: #64748b;
      }

      .flow-summary-list {
        display: grid;
        gap: 8px;
        margin: 0;
        padding: 0;
        list-style: none;
      }

      .flow-summary-list a {
        display: grid;
        grid-template-columns: 24px minmax(0, 1fr) auto;
        gap: 9px;
        align-items: center;
        padding: 9px 10px;
        border: 1px solid rgba(15, 23, 42, 0.08);
        border-radius: 13px;
        background: #ffffff;
        color: inherit;
        text-decoration: none;
      }

      .flow-summary-rank {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border-radius: 999px;
        background: #eff6ff;
        color: #1d4ed8;
        font-size: 11px;
        font-weight: 800;
      }

      .flow-summary-main,
      .flow-summary-count {
        display: grid;
        gap: 2px;
        min-width: 0;
      }

      .flow-summary-main strong {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
        color: #0f172a;
      }

      .flow-summary-main em,
      .flow-summary-main small,
      .flow-summary-count small,
      .flow-summary-count em {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-style: normal;
        font-size: 10px;
        color: #64748b;
      }

      .flow-summary-count {
        justify-items: end;
        text-align: right;
      }

      .flow-summary-count b {
        font-size: 14px;
        color: #dc2626;
      }
    `;
    document.head.appendChild(style);
  }

  function start() {
    injectStyle();
    renderSummary();
    window.setInterval(renderSummary, RENDER_INTERVAL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
