import { KIS_APP_KEY, KIS_APP_SECRET, KIS_BASE_URL, KIS_ENABLED, KIS_ENV, KIS_REQUEST_TIMEOUT_MS } from "./kis-provider.js";

const NativeWebSocket = globalThis.WebSocket;
const WS_URL = process.env.KIS_WS_URL || (KIS_ENV === "demo" ? "ws://ops.koreainvestment.com:31000" : "ws://ops.koreainvestment.com:21000");
const ENABLED = Boolean(NativeWebSocket) && KIS_ENABLED && !/^(0|false|no|off)$/i.test(String(process.env.KIS_REALTIME_ENABLED || "true"));
const MAX_CODES = Math.max(1, Number(process.env.KIS_REALTIME_MAX_CODES || 40));
const TR_ID = "H0STCNT0";
const FIELD_COUNT = 46;

let ws = null;
let approval = "";
let connecting = null;
let desired = new Set();
let subscribed = new Set();
const quotes = new Map();
const errors = [];
const state = {
  enabled: ENABLED,
  connected: false,
  wsUrl: WS_URL,
  trId: TR_ID,
  lastMessageAt: null,
  lastQuoteAt: null,
  lastPongAt: null,
  lastSubscribeAckAt: null,
  lastCloseAt: null,
  lastCloseCode: null,
  lastCloseReason: "",
  controlMessageCount: 0,
  subscribeAckCount: 0,
  subscribeRejectCount: 0,
  lastError: ""
};

function num(value) {
  const n = Number(String(value ?? "").replace(/,/g, "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function code(value) {
  const clean = String(value || "").replace(/\D/g, "").padStart(6, "0").slice(-6);
  return /^\d{6}$/.test(clean) ? clean : "";
}

function signed(value, sign) {
  const n = num(value);
  if (["4", "5"].includes(String(sign))) return -Math.abs(n);
  if (["1", "2"].includes(String(sign))) return Math.abs(n);
  if (String(sign) === "3") return 0;
  return n;
}

function pushError(message) {
  state.lastError = String(message || "realtime error");
  errors.unshift({ message: state.lastError, at: new Date().toISOString() });
  errors.splice(5);
}

function sendIfOpen(message) {
  if (ws && ws.readyState === NativeWebSocket.OPEN) ws.send(message);
}

async function approvalKey() {
  if (approval) return approval;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), KIS_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(new URL("/oauth2/Approval", KIS_BASE_URL), {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ grant_type: "client_credentials", appkey: KIS_APP_KEY, secretkey: KIS_APP_SECRET })
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || !json.approval_key) throw new Error(`KIS realtime approval HTTP ${response.status}: ${json.msg1 || "failed"}`);
    approval = json.approval_key;
    return approval;
  } finally {
    clearTimeout(timeout);
  }
}

function subscribeMessage(stockCode) {
  return JSON.stringify({
    header: { approval_key: approval, custtype: "P", tr_type: "1", "content-type": "utf-8" },
    body: { input: { tr_id: TR_ID, tr_key: stockCode } }
  });
}

function tradeAmountMillion(price, volume, rawTradeAmount) {
  const raw = num(rawTradeAmount);
  const derived = (Number(price || 0) * Number(volume || 0)) / 1_000_000;
  return raw > 0 ? raw / 1_000_000 : Number.isFinite(derived) ? derived : 0;
}

function handleTrade(dataCount, payload) {
  const values = String(payload || "").split("^");
  const count = Math.max(1, Number(dataCount || 1));
  for (let i = 0; i < count; i += 1) {
    const row = values.slice(i * FIELD_COUNT, i * FIELD_COUNT + FIELD_COUNT);
    if (row.length < 15) continue;
    const stockCode = code(row[0]);
    if (!stockCode) continue;
    const price = num(row[2]);
    const volume = num(row[13]);
    const updatedAt = new Date().toISOString();
    quotes.set(stockCode, {
      code: stockCode,
      time: row[1] || "",
      price,
      changeAmount: signed(row[4], row[3]),
      changeRate: signed(row[5], row[3]),
      tickVolume: num(row[12]),
      volume,
      tradeAmountMillion: tradeAmountMillion(price, volume, row[14]),
      source: "KIS WebSocket",
      updatedAt
    });
    state.lastQuoteAt = updatedAt;
  }
}

function handleControlMessage(text) {
  const json = JSON.parse(text);
  const trId = json?.header?.tr_id || json?.body?.tr_id || "";
  const body = json?.body || {};
  state.controlMessageCount += 1;

  if (trId === "PINGPONG") {
    sendIfOpen(text);
    state.lastPongAt = new Date().toISOString();
    return;
  }

  if (trId === TR_ID) {
    if (body.rt_cd === "0") {
      state.subscribeAckCount += 1;
      state.lastSubscribeAckAt = new Date().toISOString();
      return;
    }
    if (body.rt_cd) {
      state.subscribeRejectCount += 1;
      pushError(`${body.msg_cd || "KIS"}: ${body.msg1 || "realtime subscription rejected"}`);
      return;
    }
  }

  if (body.rt_cd && body.rt_cd !== "0") pushError(`${body.msg_cd || "KIS"}: ${body.msg1 || "realtime control error"}`);
}

function onMessage(event) {
  const text = typeof event?.data === "string" ? event.data : String(event?.data || "");
  state.lastMessageAt = new Date().toISOString();
  if (!text) return;

  if (text[0] === "0") {
    const parts = text.split("|");
    if (parts[1] === TR_ID) handleTrade(parts[2], parts[3]);
    return;
  }

  try {
    handleControlMessage(text);
  } catch {
    // ignore unknown control frame
  }
}

async function sendSubscriptions() {
  if (!ws || ws.readyState !== NativeWebSocket.OPEN) return;
  for (const stockCode of desired) {
    if (subscribed.has(stockCode)) continue;
    ws.send(subscribeMessage(stockCode));
    subscribed.add(stockCode);
  }
}

async function connect() {
  if (!ENABLED) return getRealtimeStatus();
  if (ws?.readyState === NativeWebSocket.OPEN) return getRealtimeStatus();
  if (connecting) return connecting;
  connecting = (async () => {
    try {
      await approvalKey();
      ws = new NativeWebSocket(WS_URL);
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("KIS websocket open timeout")), KIS_REQUEST_TIMEOUT_MS);
        ws.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
        ws.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("KIS websocket error while opening")); }, { once: true });
      });
      state.connected = true;
      state.lastError = "";
      subscribed = new Set();
      ws.addEventListener("message", onMessage);
      ws.addEventListener("close", (event) => {
        state.connected = false;
        state.lastCloseAt = new Date().toISOString();
        state.lastCloseCode = event?.code ?? null;
        state.lastCloseReason = event?.reason || "";
        subscribed = new Set();
        setTimeout(connect, 10000);
      });
      ws.addEventListener("error", () => pushError("KIS websocket error event after open"));
      await sendSubscriptions();
    } catch (error) {
      state.connected = false;
      pushError(error.message);
    } finally {
      connecting = null;
    }
    return getRealtimeStatus();
  })();
  return connecting;
}

export function startKisRealtime() {
  void connect();
  return getRealtimeStatus();
}

export async function subscribeRealtimeCodes(items = []) {
  desired = new Set([...new Set(items.map(code).filter(Boolean))].slice(0, MAX_CODES));
  await connect();
  await sendSubscriptions();
  return getRealtimeStatus();
}

export function applyRealtimeQuoteToStock(stock) {
  const quote = quotes.get(code(stock?.code));
  if (!quote) return stock;
  return {
    ...stock,
    price: quote.price || stock.price,
    changeAmount: Number.isFinite(quote.changeAmount) ? quote.changeAmount : stock.changeAmount,
    changeRate: Number.isFinite(quote.changeRate) ? quote.changeRate : stock.changeRate,
    volume: quote.volume || stock.volume,
    tradeAmountMillion: quote.tradeAmountMillion || stock.tradeAmountMillion,
    kisRealtimeQuote: quote,
    dataProvider: "KIS-WS",
    tradingValueValidation: { ...(stock.tradingValueValidation || {}), status: "kis-realtime", source: "KIS WebSocket", updatedAt: quote.updatedAt }
  };
}

export function getRealtimeStatus() {
  return { ...state, desiredCount: desired.size, subscribedCount: subscribed.size, quoteCount: quotes.size, maxCodes: MAX_CODES, errors };
}
