import assert from "node:assert/strict";

const baseUrl = (process.env.MONEYBOARD_BASE_URL || "http://localhost:4173").replace(/\/$/, "");
const strictValidation = !/^(0|false|no)$/i.test(String(process.env.STRICT_VALIDATION ?? "true"));

async function fetchJson(pathname, { timeoutMs = 180_000, allowHttpError = false } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      signal: controller.signal,
      headers: { accept: "application/json" }
    });
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (error) {
      throw new Error(`${pathname} did not return JSON. HTTP ${response.status}. Body: ${text.slice(0, 160)}`);
    }
    if (!allowHttpError && !response.ok) {
      throw new Error(`${pathname} failed with HTTP ${response.status}: ${JSON.stringify(json)}`);
    }
    return { response, json };
  } finally {
    clearTimeout(timeout);
  }
}

function assertDescending(items, field, label) {
  for (let index = 1; index < items.length; index += 1) {
    const previous = Number(items[index - 1]?.[field] || 0);
    const current = Number(items[index]?.[field] || 0);
    assert.ok(previous >= current, `${label} order error at ${index}: ${previous} < ${current}`);
  }
}

function assertValidStock(stock, context) {
  assert.match(String(stock.code || ""), /^\d{6}$/, `${context}: stock code must be a 6-digit code`);
  assert.ok(stock.name, `${context}: stock name is missing`);
  assert.ok(Number(stock.price || 0) >= 0, `${context}: price must be numeric`);
  assert.ok(Number(stock.volume || 0) >= 0, `${context}: volume must be numeric`);
  assert.ok(Number(stock.tradeAmountMillion || 0) >= 0, `${context}: trading value must be numeric`);
}

console.log(`Testing Moneyboard live server: ${baseUrl}`);

const provider = (await fetchJson("/api/provider", { timeoutMs: 15_000 })).json;
assert.equal(provider.mode, "localhost-live", "provider mode must be localhost-live");
assert.ok(provider.rankingBasis?.includes("trading-value"), "ranking basis must be trading value");

const snapshot = (await fetchJson("/api/sectors?force=1", { timeoutMs: 240_000 })).json;
assert.equal(snapshot.mode, "localhost-live", "snapshot mode must be localhost-live");
assert.ok(Array.isArray(snapshot.sectors), "snapshot.sectors must be an array");
assert.ok(snapshot.sectors.length > 0, "at least one sector must be loaded");
assert.ok(snapshot.totals?.sectorCount > 0, "totals.sectorCount must be positive");
assertDescending(snapshot.sectors, "tradingValueMillion", "sector trading value");

for (const [sectorIndex, sector] of snapshot.sectors.entries()) {
  assert.ok(sector.id, `sector ${sectorIndex}: id is missing`);
  assert.ok(sector.name, `sector ${sectorIndex}: name is missing`);
  assert.ok(Number(sector.tradingValueMillion || 0) >= 0, `sector ${sector.name}: trading value must be numeric`);
  assert.ok(Array.isArray(sector.stocks), `sector ${sector.name}: stocks must be an array`);
  assertDescending(sector.stocks || [], "tradeAmountMillion", `sector ${sector.name} stocks`);
  for (const [stockIndex, stock] of (sector.stocks || []).slice(0, 20).entries()) {
    assertValidStock(stock, `${sector.name} stock ${stockIndex + 1}`);
  }
}

const validationResult = await fetchJson("/api/validation", { timeoutMs: 240_000, allowHttpError: true });
assert.ok(validationResult.json, "validation response must contain JSON");
if (strictValidation) {
  assert.equal(validationResult.response.status, 200, `strict validation failed: ${JSON.stringify(validationResult.json)}`);
  assert.equal(validationResult.json.status, "ok", `validation status must be ok: ${JSON.stringify(validationResult.json)}`);
  assert.equal(Number(validationResult.json.errorCount || 0), 0, `validation errorCount must be 0: ${JSON.stringify(validationResult.json)}`);
}

const detailsToCheck = snapshot.sectors.slice(0, Math.min(5, snapshot.sectors.length));
for (const sector of detailsToCheck) {
  const detail = (await fetchJson(`/api/sectors/${sector.id}`, { timeoutMs: 180_000 })).json;
  assert.equal(String(detail.id), String(sector.id), `detail id mismatch: selected ${sector.id}, received ${detail.id}`);
  assert.ok(Array.isArray(detail.stocks), `detail ${sector.name}: stocks must be an array`);
  assertDescending(detail.stocks, "tradeAmountMillion", `detail ${sector.name} stocks`);
  for (const [stockIndex, stock] of detail.stocks.slice(0, 20).entries()) {
    assertValidStock(stock, `detail ${sector.name} stock ${stockIndex + 1}`);
  }
}

const samsungQuote = await fetchJson("/api/kis/quote/005930", { timeoutMs: 60_000, allowHttpError: true });
if (provider.kis?.enabled) {
  assert.equal(samsungQuote.response.status, 200, `KIS quote failed while KIS is enabled: ${JSON.stringify(samsungQuote.json)}`);
  assert.equal(samsungQuote.json.code, "005930", "KIS quote must preserve requested stock code");
  assert.ok(Number(samsungQuote.json.price || 0) > 0, "KIS quote price must be positive when KIS is enabled");
} else {
  assert.ok([400, 502].includes(samsungQuote.response.status), "KIS quote should be disabled or unavailable when KIS is not enabled");
}

console.log(JSON.stringify({
  status: "ok",
  sectors: snapshot.sectors.length,
  topSector: snapshot.sectors[0]?.name,
  validation: validationResult.json,
  kis: provider.kis
}, null, 2));
