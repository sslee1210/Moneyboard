import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT || 4173);
const BASE_URL = process.env.MONEYBOARD_BASE_URL || `http://localhost:${PORT}`;
const MONITOR_INTERVAL_MS = Math.max(5_000, Number(process.env.MONEYBOARD_MONITOR_INTERVAL_MS || 10_000));
const SNAPSHOT_TIMEOUT_MS = Math.max(60_000, Number(process.env.MONEYBOARD_SNAPSHOT_TIMEOUT_MS || 180_000));
const SERVER_ENTRY = process.env.MONEYBOARD_SERVER_ENTRY || "server-focus40.js";

const serverEnv = {
  ...process.env,
  // 화면/SSE는 1초 단위로 밀어주고, 후보 재선정용 네이버 스냅샷은 3초 캐시로 둔다.
  STREAM_PUSH_MS: process.env.STREAM_PUSH_MS || "1000",
  MARKET_CACHE_MS: process.env.MARKET_CACHE_MS || "3000",
  OVERVIEW_CACHE_MS: process.env.OVERVIEW_CACHE_MS || "3000",
  DETAIL_CACHE_MS: process.env.DETAIL_CACHE_MS || "3000",
  DETAIL_CONCURRENCY: process.env.DETAIL_CONCURRENCY || "16",
  REQUEST_TIMEOUT_MS: process.env.REQUEST_TIMEOUT_MS || "6000",

  // KIS/브로커 REST fallback은 focus-40만 빠르게 순환한다. 실시간 체결은 WebSocket/브리지 우선이다.
  KIS_REQUEST_TIMEOUT_MS: process.env.KIS_REQUEST_TIMEOUT_MS || "6000",
  KIS_QUOTE_CACHE_MS: process.env.KIS_QUOTE_CACHE_MS || "1000",
  KIS_MARKET_VERIFY_TOP_SECTORS: process.env.KIS_MARKET_VERIFY_TOP_SECTORS || "0",
  KIS_MARKET_VERIFY_TOP_STOCKS: process.env.KIS_MARKET_VERIFY_TOP_STOCKS || "0",
  KIS_SELECTED_SECTOR_STOCKS: process.env.KIS_SELECTED_SECTOR_STOCKS || "0",
  KIS_NUMERIC_SOURCE: process.env.KIS_NUMERIC_SOURCE || "api-only",
  KIS_FOCUS_SECTORS: process.env.KIS_FOCUS_SECTORS || "8",
  KIS_FOCUS_STOCKS_PER_SECTOR: process.env.KIS_FOCUS_STOCKS_PER_SECTOR || "5",
  KIS_FOCUS_MAX_CODES: process.env.KIS_FOCUS_MAX_CODES || "40",
  KIS_FOCUS_BACKFILL_INTERVAL_MS: process.env.KIS_FOCUS_BACKFILL_INTERVAL_MS || "1000",
  KIS_RATE_LIMIT_COOLDOWN_MS: process.env.KIS_RATE_LIMIT_COOLDOWN_MS || "8000",
  KIS_REALTIME_MAX_CODES: process.env.KIS_REALTIME_MAX_CODES || "40",

  // 키움 브리지/모의투자 전환용 기본값. 실제 연결 코드는 .env의 KIWOOM_* 값이 들어오면 이 설정을 우선 사용한다.
  PRECISION_API_PROVIDER: process.env.PRECISION_API_PROVIDER || "kiwoom",
  PRECISION_API_ENABLED: process.env.PRECISION_API_ENABLED || process.env.KIWOOM_ENABLED || "false",
  PRECISION_WATCH_LIMIT: process.env.PRECISION_WATCH_LIMIT || process.env.KIWOOM_WATCH_LIMIT || "40",
  PRECISION_SOURCE_TOP_SECTORS: process.env.PRECISION_SOURCE_TOP_SECTORS || "16",
  PRECISION_MARKET_SCOPE: process.env.PRECISION_MARKET_SCOPE || "KRX_SELECTED",
  KIWOOM_WATCH_LIMIT: process.env.KIWOOM_WATCH_LIMIT || "40",
  KIWOOM_REGISTER_REFRESH_MS: process.env.KIWOOM_REGISTER_REFRESH_MS || "3000",
  KIWOOM_REALTIME_PUSH_MS: process.env.KIWOOM_REALTIME_PUSH_MS || "1000",
  KIWOOM_RESELECT_MS: process.env.KIWOOM_RESELECT_MS || "3000",
  KIWOOM_REAL_FIDS: process.env.KIWOOM_REAL_FIDS || "10;13;14;15;20;228"
};

let monitorTimer = null;
let primingStarted = false;
let lastCoverage = -1;
let lastValidation = null;
let validationTimer = 0;
let lastRateLimitCount = 0;
let lastRateLimitNoticeAt = 0;

function now() {
  return new Date().toLocaleTimeString("ko-KR", { hour12: false });
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return { controller, timeout };
}

async function fetchJson(pathname, timeoutMs = 12_000) {
  const { controller, timeout } = withTimeout(timeoutMs);
  try {
    const response = await fetch(`${BASE_URL}${pathname}`, { signal: controller.signal });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 300) };
    }
    if (!response.ok) throw new Error(`${pathname} HTTP ${response.status}: ${text.slice(0, 200)}`);
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function pct(value) {
  const num = Number(value || 0);
  return `${(num * 100).toFixed(1)}%`;
}

function compactError(message) {
  return String(message || "").replace(/\s+/g, " ").slice(0, 120);
}

async function waitForServer() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60_000) {
    try {
      const provider = await fetchJson("/api/provider", 3_000);
      const focus = provider.focusPolicy || {};
      console.log(`[doctor ${now()}] provider=${provider.provider} mode=${provider.mode} kis=${provider.kis?.enabled ? provider.kis.env : "off"}`);
      console.log(
        `[doctor ${now()}] focus=${focus.topSectors ?? serverEnv.KIS_FOCUS_SECTORS} sectors x ${focus.topStocksPerSector ?? serverEnv.KIS_FOCUS_STOCKS_PER_SECTOR} stocks, max=${focus.maxCodes ?? serverEnv.KIS_FOCUS_MAX_CODES}, REST interval=${serverEnv.KIS_FOCUS_BACKFILL_INTERVAL_MS}ms, cooldown=${serverEnv.KIS_RATE_LIMIT_COOLDOWN_MS}ms, stream=${serverEnv.STREAM_PUSH_MS}ms, marketCache=${serverEnv.MARKET_CACHE_MS}ms`
      );
      console.log(
        `[doctor ${now()}] kiwoom-fast provider=${serverEnv.PRECISION_API_PROVIDER} watch=${serverEnv.PRECISION_WATCH_LIMIT} reselect=${serverEnv.KIWOOM_RESELECT_MS}ms push=${serverEnv.KIWOOM_REALTIME_PUSH_MS}ms register=${serverEnv.KIWOOM_REGISTER_REFRESH_MS}ms`
      );
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw new Error(`Moneyboard server did not respond at ${BASE_URL}`);
}

async function primeSnapshot() {
  if (primingStarted) return;
  primingStarted = true;
  console.log(`[doctor ${now()}] first market snapshot is being built automatically. Focus-40 broker backfill starts after this finishes.`);
  try {
    const snapshot = await fetchJson("/api/sectors?force=1", SNAPSHOT_TIMEOUT_MS);
    const totals = snapshot.totals || {};
    const focus = snapshot.focusPolicy || {};
    console.log(
      `[doctor ${now()}] snapshot ready: sectors=${snapshot.sectors?.length || 0}, stocks=${totals.stockCount || 0}, focus=${focus.codes?.length || 0}, apiReady=${totals.apiReadyStockCount || 0}, pending=${totals.apiPendingCount || 0}`
    );
  } catch (error) {
    console.log(`[doctor ${now()}] snapshot build warning: ${compactError(error.message)}`);
  }
}

async function getValidationSnapshot() {
  const nowMs = Date.now();
  if (lastValidation && nowMs - validationTimer < 30_000) return lastValidation;
  try {
    lastValidation = await fetchJson("/api/validation", 90_000);
    validationTimer = nowMs;
    return lastValidation;
  } catch (error) {
    return lastValidation || { status: "warning", error: compactError(error.message) };
  }
}

async function printDiagnostics() {
  try {
    const [backfill, realtime, validation] = await Promise.all([
      fetchJson("/api/backfill/status", 10_000),
      fetchJson("/api/realtime/status", 10_000),
      getValidationSnapshot()
    ]);

    const coverage = Number(backfill.coverageRate || 0);
    const coverageMoved = Math.abs(coverage - lastCoverage) >= 0.001;
    lastCoverage = coverage;

    const backfillLine = `focus-backfill ${backfill.cachedQuoteCount}/${backfill.universeSize} ${pct(backfill.coverageRate)} pending=${backfill.pendingSize} ok=${backfill.successCount} err=${backfill.errorCount} rateLimit=${backfill.rateLimitCount || 0} cooldown=${Math.ceil((backfill.cooldownMsRemaining || 0) / 1000)}s`;
    const realtimeLine = `realtime connected=${realtime.connected} sub=${realtime.subscribedCount}/${realtime.maxCodes} ack=${realtime.subscribeAckCount} reject=${realtime.subscribeRejectCount} quotes=${realtime.quoteCount}`;
    const validationLine = `validation=${validation.status || "unknown"} apiReady=${validation.apiReadyStockCount ?? "?"} apiPending=${validation.apiPendingCount ?? "?"} orderErrors=${validation.errorCount ?? "?"}`;

    console.log(`[doctor ${now()}] ${backfillLine} | ${realtimeLine} | ${validationLine}`);

    const rateLimitCount = Number(backfill.rateLimitCount || 0);
    if (rateLimitCount > lastRateLimitCount) {
      const nowMs = Date.now();
      if (nowMs - lastRateLimitNoticeAt > 30_000) {
        console.log(
          `[doctor ${now()}] REST rate-limit handled automatically: cooldown=${Math.ceil((backfill.cooldownMsRemaining || 0) / 1000)}s, failed code was re-queued.`
        );
        lastRateLimitNoticeAt = nowMs;
      }
      lastRateLimitCount = rateLimitCount;
    } else if (backfill.lastError && !/초당|거래건수|rate|limit|too many/i.test(backfill.lastError)) {
      console.log(`[doctor ${now()}] last REST event: ${compactError(backfill.lastError)}`);
    }

    if (realtime.lastError) console.log(`[doctor ${now()}] last realtime error: ${compactError(realtime.lastError)}`);
    if (!coverageMoved && backfill.universeSize > 0 && backfill.pendingSize > 0 && backfill.inFlight === 0 && !backfill.cooldownMsRemaining) {
      console.log(`[doctor ${now()}] focus backfill is queued but not advancing. Check broker REST status.`);
    }
  } catch (error) {
    console.log(`[doctor ${now()}] diagnostics warning: ${compactError(error.message)}`);
  }
}

async function startMonitor() {
  await waitForServer();
  void primeSnapshot();
  await printDiagnostics();
  monitorTimer = setInterval(printDiagnostics, MONITOR_INTERVAL_MS);
}

console.log(
  `[doctor ${now()}] fast runtime: stream=${serverEnv.STREAM_PUSH_MS}ms, market=${serverEnv.MARKET_CACHE_MS}ms, detail=${serverEnv.DETAIL_CACHE_MS}ms, REST backfill=${serverEnv.KIS_FOCUS_BACKFILL_INTERVAL_MS}ms, focus=${serverEnv.KIS_FOCUS_SECTORS}x${serverEnv.KIS_FOCUS_STOCKS_PER_SECTOR}`
);

const child = spawn(process.execPath, [SERVER_ENTRY], { env: serverEnv, stdio: ["inherit", "pipe", "pipe"] });

child.stdout.on("data", (data) => process.stdout.write(`[server] ${data}`));
child.stderr.on("data", (data) => process.stderr.write(`[server] ${data}`));
child.on("exit", (code, signal) => {
  if (monitorTimer) clearInterval(monitorTimer);
  console.log(`[doctor ${now()}] server exited code=${code ?? ""} signal=${signal ?? ""}`);
  process.exit(code || 0);
});

process.on("SIGINT", () => {
  if (monitorTimer) clearInterval(monitorTimer);
  child.kill("SIGINT");
});
process.on("SIGTERM", () => {
  if (monitorTimer) clearInterval(monitorTimer);
  child.kill("SIGINT");
});

startMonitor().catch((error) => {
  console.log(`[doctor ${now()}] monitor failed: ${compactError(error.message)}`);
});
