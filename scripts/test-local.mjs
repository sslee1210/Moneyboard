import { spawn } from "node:child_process";

const port = Number(process.env.PORT || 4173);
const baseUrl = (process.env.MONEYBOARD_BASE_URL || `http://localhost:${port}`).replace(/\/$/, "");
const startupTimeoutMs = Number(process.env.MONEYBOARD_STARTUP_TIMEOUT_MS || 120_000);
const serverEntry = process.env.MONEYBOARD_SERVER_ENTRY || "server-local.js";

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
      if (provider.mode === "localhost-live-sanitized") return provider;
      lastError = `/api/provider responded, but mode is ${provider.mode}. Expected localhost-live-sanitized. Check that no old server is already using port ${port}.`;
    } catch (error) {
      lastError = error.message;
    }
    await wait(1_000);
  }

  throw new Error(`Moneyboard sanitized server did not become ready at ${baseUrl}. Last error: ${lastError}`);
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
  MARKET_CACHE_MS: process.env.MARKET_CACHE_MS || "10000",
  DETAIL_CACHE_MS: process.env.DETAIL_CACHE_MS || "30000",
  MONEYBOARD_BASE_URL: baseUrl
};

console.log(`Starting Moneyboard sanitized local test server at ${baseUrl}`);
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
