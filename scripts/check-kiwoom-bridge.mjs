import fs from "node:fs";
import path from "node:path";

function loadDotEnv(filePath = path.resolve(process.cwd(), ".env")) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function joinUrl(base, route) {
  const root = String(base || "").replace(/\/+$/, "");
  const suffix = String(route || "/health").startsWith("/") ? route : `/${route}`;
  return `${root}${suffix}`;
}

loadDotEnv();

const bridgeUrl = process.env.KIWOOM_BRIDGE_URL || "http://127.0.0.1:8765";
const healthPath = process.env.KIWOOM_HEALTH_PATH || "/health";
const timeoutMs = Number(process.env.KIWOOM_TIMEOUT_MS || 5000);
const url = joinUrl(bridgeUrl, healthPath);

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs);

try {
  const headers = {};
  if (process.env.KIWOOM_BRIDGE_TOKEN) {
    headers.Authorization = `Bearer ${process.env.KIWOOM_BRIDGE_TOKEN}`;
  }

  const response = await fetch(url, { headers, signal: controller.signal });
  const text = await response.text();
  clearTimeout(timer);

  if (!response.ok) {
    console.error("[kiwoom] bridge health failed", {
      url,
      status: response.status,
      body: text.slice(0, 500)
    });
    process.exit(1);
  }

  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep raw text
  }

  console.log("[kiwoom] bridge ok", {
    url,
    status: response.status,
    body
  });
} catch (error) {
  clearTimeout(timer);
  console.error("[kiwoom] bridge check failed", {
    url,
    error: error.name === "AbortError" ? `timeout after ${timeoutMs}ms` : error.message
  });
  process.exit(1);
}
