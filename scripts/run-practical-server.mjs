import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT || 4173);
const BASE_URL = process.env.MONEYBOARD_BASE_URL || `http://localhost:${PORT}`;
const MONITOR_INTERVAL_MS = Math.max(10_000, Number(process.env.MONEYBOARD_MONITOR_INTERVAL_MS || 30_000));
const SNAPSHOT_TIMEOUT_MS = Math.max(60_000, Number(process.env.MONEYBOARD_SNAPSHOT_TIMEOUT_MS || 180_000));
const SERVER_ENTRY = process.env.MONEYBOARD_SERVER_ENTRY || "server.js";

const serverEnv = {
  ...process.env,
  PORT: String(PORT),
  STREAM_PUSH_MS: process.env.STREAM_PUSH_MS || "30000",
  MARKET_CACHE_MS: process.env.MARKET_CACHE_MS || "30000",
  DETAIL_CACHE_MS: process.env.DETAIL_CACHE_MS || "20000",
  DETAIL_CONCURRENCY: process.env.DETAIL_CONCURRENCY || "8",
  OVERVIEW_CACHE_MS: process.env.OVERVIEW_CACHE_MS || "5000"
};

let monitorTimer = null;
let primingStarted = false;

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

function compactError(message) {
  return String(message || "").replace(/\s+/g, " ").slice(0, 160);
}

function formatWonFromMillion(value) {
  const million = Number(value || 0);
  const eok = million / 100;
  return `${Math.round(eok).toLocaleString("ko-KR")}억`;
}

async function waitForServer() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60_000) {
    try {
      const provider = await fetchJson("/api/provider", 3_000);
      console.log(
        `[doctor ${now()}] provider=${provider.market || provider.provider || "Naver Finance"} overview=${provider.overviewProvider || "Yahoo Finance"} mode=localhost-live kis=${provider.kis?.enabled ? "on" : "off"}`
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
  console.log(`[doctor ${now()}] first market snapshot is being built automatically.`);
  try {
    const snapshot = await fetchJson("/api/sectors?force=1", SNAPSHOT_TIMEOUT_MS);
    const totals = snapshot.totals || {};
    const overviewCount = snapshot.overview?.items?.length || 0;
    console.log(
      `[doctor ${now()}] snapshot ready: sectors=${snapshot.sectors?.length || 0}, totalValue=${formatWonFromMillion(totals.tradingValueMillion)}, overview=${overviewCount} items, right-flow-alerts=frontend`
    );
    if (!overviewCount) {
      console.log(`[doctor ${now()}] overview warning: /api/sectors responded without Yahoo overview items.`);
    }
  } catch (error) {
    console.log(`[doctor ${now()}] snapshot build warning: ${compactError(error.message)}`);
  }
}

async function printDiagnostics() {
  try {
    const [health, snapshot] = await Promise.all([
      fetchJson("/api/health", 5_000),
      fetchJson("/api/sectors", 30_000)
    ]);
    const totals = snapshot.totals || {};
    const breadth = totals.breadth || {};
    const overviewCount = snapshot.overview?.items?.length || 0;
    console.log(
      `[doctor ${now()}] health=${health.ok ? "ok" : "watch"} sectors=${snapshot.sectors?.length || 0} totalValue=${formatWonFromMillion(totals.tradingValueMillion)} breadth=▲${breadth.rising || 0}/-${breadth.flat || 0}/▼${breadth.falling || 0} overview=${overviewCount}`
    );
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
