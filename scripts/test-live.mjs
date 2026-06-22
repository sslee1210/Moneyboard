import assert from "node:assert/strict";

const baseUrl = process.env.MONEYBOARD_BASE_URL || "http://localhost:4173";
const timeoutMs = Number(process.env.MONEYBOARD_SNAPSHOT_TIMEOUT_MS || 300000);

async function fetchJson(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      signal: controller.signal,
      headers: { accept: "application/json" }
    });
    const body = await response.text();
    const json = body ? JSON.parse(body) : null;
    if (!response.ok && path !== "/api/validation") {
      throw new Error(`${path} returned HTTP ${response.status}: ${body.slice(0, 200)}`);
    }
    return { response, json };
  } finally {
    clearTimeout(timer);
  }
}

function assertDescending(rows, field, label) {
  for (let index = 1; index < rows.length; index += 1) {
    const before = Number(rows[index - 1]?.[field] || 0);
    const current = Number(rows[index]?.[field] || 0);
    assert.ok(before >= current, `${label} sort error at ${index}: ${before} < ${current}`);
  }
}

function assertStock(stock, label) {
  assert.match(String(stock.code || ""), /^\d{6}$/, `${label}: stock code must be a 6-digit code`);
  assert.ok(stock.name, `${label}: stock name is missing`);
  assert.ok(Number(stock.price || 0) >= 0, `${label}: price must be numeric`);
  assert.ok(Number(stock.volume || 0) >= 0, `${label}: volume must be numeric`);
  assert.ok(Number(stock.tradeAmountMillion || 0) >= 0, `${label}: trading value must be numeric`);
}

console.log(`Testing Moneyboard live server: ${baseUrl}`);

const provider = (await fetchJson("/api/provider")).json;
assert.ok(provider.provider, "provider must be present");
assert.ok(provider.rankingBasis?.includes("trading-value"), "ranking basis must be trading value");

const snapshot = (await fetchJson("/api/sectors")).json;
assert.ok(Array.isArray(snapshot.sectors), "snapshot.sectors must be an array");
assert.ok(snapshot.sectors.length > 0, "at least one sector must be loaded");
assertDescending(snapshot.sectors, "tradingValueMillion", "sectors");

for (const [sectorIndex, sector] of snapshot.sectors.entries()) {
  assert.ok(sector.id, `sector ${sectorIndex}: id is missing`);
  assert.ok(sector.name, `sector ${sectorIndex}: name is missing`);
  assert.ok(Array.isArray(sector.stocks), `sector ${sector.name}: stocks must be an array`);
  assertDescending(sector.stocks, "tradeAmountMillion", `sector ${sector.name} stocks`);
  for (const [stockIndex, stock] of sector.stocks.slice(0, 20).entries()) {
    assertStock(stock, `${sector.name} stock ${stockIndex + 1}`);
  }
}

for (const sector of snapshot.sectors.slice(0, 5)) {
  const detail = (await fetchJson(`/api/sectors/${sector.id}`)).json;
  assert.equal(String(detail.id), String(sector.id), `detail id mismatch for ${sector.name}`);
  assert.ok(Array.isArray(detail.stocks), `detail ${sector.name}: stocks must be an array`);
  assertDescending(detail.stocks, "tradeAmountMillion", `detail ${sector.name} stocks`);
  for (const [stockIndex, stock] of detail.stocks.slice(0, 20).entries()) {
    assertStock(stock, `detail ${sector.name} stock ${stockIndex + 1}`);
  }
}

const validation = await fetchJson("/api/validation");
assert.ok(validation.json, "validation response must contain JSON");
assert.equal(Number(validation.json.errorCount || 0), 0, `validation errorCount must be 0: ${JSON.stringify(validation.json)}`);

const samsung = await fetchJson("/api/kis/quote/005930");
if (provider.kis?.enabled) {
  assert.equal(samsung.response.status, 200, `KIS quote failed: ${JSON.stringify(samsung.json)}`);
  assert.equal(samsung.json.code, "005930", "KIS quote must preserve requested code");
}

console.log(JSON.stringify({
  status: "ok",
  provider: provider.provider,
  runtime: provider.runtime || provider.mode,
  sectors: snapshot.sectors.length,
  topSector: snapshot.sectors[0]?.name,
  validation: validation.json
}, null, 2));
