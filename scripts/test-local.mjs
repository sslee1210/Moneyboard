import { spawn } from "node:child_process";

const port = Number(process.env.PORT || 4173);
const baseUrl = (process.env.MONEYBOARD_BASE_URL || `http://localhost:${port}`).replace(/\/$/, "");
const startupTimeoutMs = Number(process.env.MONEYBOARD_STARTUP_TIMEOUT_MS || 120_000);
const serverEntry = process.env.MONEYBOARD_SERVER_ENTRY || "server-practical.js";
const acceptedModes = new Set(["localhost-live", "localhost-live-sanitized", "localhost-live-kis-api-only", "localhost-practical-kis-backfill"]);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readProvider() {
  const response = await fetch(`${baseUrl}/api/provider`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(3_000)
  });

  if (!response.ok) throw new Error(`/api/provider returned HTTP ${response.status}`);
  return response.json();
}

async function waitForServer() {
  const startedAt = Date.now();
  let lastError = "server has not responded yet";

  while (Date.now() - startedAt < startupTimeoutMs) {
    try {
      const provider = await readProvider();
      if (acceptedModes.has(provider.mode)) return provider;
      lastError = `/api/provider responded, but mode is ${provider.mode}. Check that no unrelated server is already using port ${port}.`;
    } catch (error) {
      lastError = error.message;
    }
    await wait(1_000);
  }

  throw new Error(`Moneyboard server did not become ready at ${baseUrl}. Last error: ${lastError}`);
}

function runNodeScript(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      stdio: "inherit",
      env
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with code ${code}`));
    });
  });
}

const env = {
  ...process.env,
  PORT: String(port),
  STREAM_PUSH_MS: process.env.STREAM_PUSH_MS || "2000",
  MARKET_CACHE_MS: process.env.MARKET_CACHE_MS || "30000",
  DETAIL_CACHE_MS: process.env.DETAIL_CACHE_MS || "30000",
  KIS_MARKET_VERIFY_TOP_SECTORS: process.env.KIS_MARKET_VERIFY_TOP_SECTORS || "0",
  KIS_MARKET_VERIFY_TOP_STOCKS: process.env.KIS_MARKET_VERIFY_TOP_STOCKS || "0",
  KIS_SELECTED_SECTOR_STOCKS: process.env.KIS_SELECTED_SECTOR_STOCKS || "0",
  KIS_NUMERIC_SOURCE: process.env.KIS_NUMERIC_SOURCE || "api-only",
  KIS_REST_BACKFILL_ENABLED: process.env.KIS_REST_BACKFILL_ENABLED || "true",
  KIS_REST_BACKFILL_MAX_CODES: process.env.KIS_REST_BACKFILL_MAX_CODES || "3000",
  KIS_REST_BACKFILL_BATCH_SIZE: process.env.KIS_REST_BACKFILL_BATCH_SIZE || "2",
  KIS_REST_BACKFILL_INTERVAL_MS: process.env.KIS_REST_BACKFILL_INTERVAL_MS || "500",
  KIS_REALTIME_MAX_CODES: process.env.KIS_REALTIME_MAX_CODES || "40",
  MONEYBOARD_BASE_URL: baseUrl
};

console.log(`Starting Moneyboard local test server at ${baseUrl}`);
console.log(`Server entry: ${serverEntry}`);
const server = spawn(process.execPath, [serverEntry], {
  stdio: ["ignore", "pipe", "pipe"],
  env
});

server.stdout.on("data", (chunk) => process.stdout.write(`[server] ${chunk}`));
server.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));

let serverExited = false;
server.on("exit", (code) => {
  serverExited = true;
  if (code !== 0 && code !== null) {
    console.error(`[server] exited with code ${code}`);
  }
});

try {
  const provider = await waitForServer();
  console.log(`Provider mode confirmed: ${provider.mode}`);
  if (serverExited) throw new Error("Moneyboard server exited before tests started.");
  await runNodeScript("scripts/test-live.mjs", env);
} finally {
  if (!server.killed) server.kill();
}
