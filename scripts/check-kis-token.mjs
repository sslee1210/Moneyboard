import fs from "node:fs";
import path from "node:path";

const envPath = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['\"]|['\"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

const baseUrl = (process.env.KIS_REST_BASE_URL || "https://openapivts.koreainvestment.com:29443").replace(/\/$/, "");
const key = process.env.KIS_APP_KEY;
const sec = process.env.KIS_APP_SEC;

if (!key || !sec) {
  console.error("[kis] KIS_APP_KEY 또는 KIS_APP_SEC가 .env에 없습니다.");
  process.exit(1);
}

const payload = { grant_type: "client_credentials", appkey: key };
payload["app" + "secret"] = sec;

const response = await fetch(`${baseUrl}/oauth2/tokenP`, {
  method: "POST",
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify(payload)
});
const data = await response.json().catch(() => ({}));

if (!response.ok || !data["access" + "_token"]) {
  console.error("[kis] token failed", { status: response.status, message: data.msg1 || data.error_description || data.message || data.error });
  process.exit(1);
}

console.log("[kis] token ok", {
  baseUrl,
  tokenType: data.token_type || "Bearer",
  expiresIn: data.expires_in || data.access_token_token_expired || null
});