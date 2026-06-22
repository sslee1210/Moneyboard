import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT || 4173);
const BASE_URL = process.env.MONEYBOARD_BASE_URL || `http://localhost:${PORT}`;
const MONITOR_INTERVAL_MS = Math.max(10_000, Number(process.env.MONEYBOARD_MONITOR_INTERVAL_MS || 30_000));
const SNAPSHOT_TIMEOUT_MS = Math.max(60_000, Number(process.env.MONEYBOARD_SNAPSHOT_TIMEOUT_MS || 180_000));
const SERVER_ENTRY = process.env.MONEYBOARD_SERVER_ENTRY || "server-focus40.js";

const serverEnv = {
  ...process.env,
  STREAM_PUSH_MS: process.env.STREAM_PUSH_MS || "3000",
  MARKET_CACHE_MS: process.env.MARKET_CACHE_MS || "15000",
  DETAIL_CACHE_MS: process.env.DETAIL_CACHE_MS || "30000",
  DETAIL_CONCURRENCY: process.env.DETAIL_CONCURRENCY || "8",
  KIS_REQUEST_TIMEOUT_MS: process.env.KIS_REQUEST_TIMEOUT_MS || "12000",
  KIS_QUOTE_CACHE_MS: process.env.KIS_QUOTE_CACHE_MS || "30000",
  KIS_MARKET_VERIFY_TOP_SECTORS: process.env.KIS_MARKET_VERIFY_TOP_SECTORS || "0",
  KIS_MARKET_VERIFY_TOP_STOCKS: process.env.KIS_MARKET_VERIFY_TOP_STOCKS || "0",
  KIS_SELECTED_SECTOR_STOCKS: process.env.KIS_SELECTED_SECTOR_STOCKS || "0",
  KIS_NUMERIC_SOURCE: process.env.KIS_NUMERIC_SOURCE || "api-only",
  KIS_FOCUS_SECTORS: process.env.KIS_FOCUS_SECTORS || "8",
  KIS_FOCUS_STOCKS_PER_SECTOR: process.env.KIS_FOCUS_STOCKS_PER_SECTOR || "5",
  KIS_FOCUS_MAX_CODES: process.env.KIS_FOCUS_MAX_CODES || "40",
  KIS_FOCUS_BACKFILL_INTERVAL_MS: process.env.KIS_FOCUS_BACKFILL_INTERVAL_MS || "2000",
  KIS_RATE_LIMIT_COOLDOWN_MS: process.env.KIS_RATE_LIMIT_COOLDOWN_MS || "15000",
  KIS_REALTIME_MAX_CODES: process.env.KIS_REALTIME_MAX_CODES || "40"
};

let monitorTimer = null;
let primingStarted = false;
let lastCoverage = -1;
let lastValidation = null;
let validationTimer = 0;

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
        `[doctor ${now()}] focus=${focus.topSectors ?? serverEnv.KIS_FOCUS_SECTORS} sectors x ${focus.topStocksPerSector ?? serverEnv.KIS_FOCUS_STOCKS_PER_SECTOR} stocks, max=${focus.maxCodes ?? serverEnv.KIS_FOCUS_MAX_CODES}, REST interval=${serverEnv.KIS_FOCUS_BACKFILL_INTERVAL_MS}ms, cooldown=${serverEnv.KIS_RATE_LIMIT_COOLDOWN_MS}ms, stream=${serverEnv.STREAM_PUSH_MS}ms`
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
  console.log(`[doctor ${now()}] first market snapshot is being built automatically. Focus-40 KIS backfill starts after this finishes.`);
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
  if (lastValidation && nowMs - validationTimer < 60_000) return lastValidation;
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

    if (backfill.lastError) console.log(`[doctor ${now()}] last KIS REST event: ${compactError(backfill.lastError)}`);
    if (realtime.lastError) console.log(`[doctor ${now()}] last KIS WS error: ${compactError(realtime.lastError)}`);
    if (!coverageMoved && backfill.universeSize > 0 && backfill.pendingSize > 0 && backfill.inFlight === 0 && !backfill.cooldownMsRemaining) {
      console.log(`[doctor ${now()}] focus backfill is queued but not advancing. Check KIS REST status.`);
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
