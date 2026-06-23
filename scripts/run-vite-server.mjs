import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { createServer as createViteServer } from "vite";
import { getMarketSnapshot, getSectorDetail } from "../server.js";
import { buildPrecisionWatchlist, getKiwoomEnvStatus, getPrecisionWatchAdapterStatus } from "../server-precision-watch.js";

const PORT = Number(process.env.PORT || 4173);
const MARKET_CACHE_MS = Number(process.env.MARKET_CACHE_MS || 30_000);
const VOLUME_HISTORY_LIMIT = Number(process.env.VOLUME_HISTORY_LIMIT || 12);

function withPrecisionWatchlist(snapshot) {
  const precisionWatchlist = buildPrecisionWatchlist(snapshot);
  return {
    ...snapshot,
    precisionWatchlist
  };
}

function buildVolumeProfile(stocks, limit = VOLUME_HISTORY_LIMIT) {
  const items = (stocks || []).slice(0, limit).map((stock) => ({
    code: stock.code,
    name: stock.name,
    day: stock.volume || 0,
    week: stock.periodVolumes?.week ?? null,
    month: stock.periodVolumes?.month ?? null
  }));

  return {
    sampleSize: items.length,
    limit,
    provider: "Naver Finance",
    byCode: Object.fromEntries(items.map((item) => [item.code, item])),
    counts: {
      day: items.filter((item) => item.day !== null && item.day !== undefined).length,
      week: items.filter((item) => item.week !== null && item.week !== undefined).length,
      month: items.filter((item) => item.month !== null && item.month !== undefined).length
    },
    totals: {
      day: items.reduce((sum, item) => sum + (item.day || 0), 0),
      week: items.reduce((sum, item) => sum + (item.week || 0), 0),
      month: items.reduce((sum, item) => sum + (item.month || 0), 0)
    },
    updatedAt: new Date().toISOString()
  };
}

function applyCors(request, response, next) {
  const origin = request.headers.origin;
  if (origin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (request.method === "OPTIONS") {
    response.sendStatus(204);
    return;
  }

  next();
}

function buildProviderStatus() {
  const adapter = getPrecisionWatchAdapterStatus();
  return {
    market: "Naver Finance broad scan",
    sectorDetail: "Naver Finance",
    overviewProvider: "Yahoo Finance",
    volumeProfile: "Naver Finance day-volume only",
    precisionWatch: {
      broadScan: "Naver Finance all-sector scan",
      selectedUniverse: "top-ranked candidates only",
      endpoint: "/api/precision-watchlist",
      adapter
    },
    kiwoom: adapter.kiwoom,
    kis: adapter.kis
  };
}

async function main() {
  const app = express();
  app.use(applyCors);
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", (_, response) => {
    response.json({
      ok: true,
      mode: "localhost-live-vite",
      provider: "Naver Finance",
      overviewProvider: "Yahoo Finance",
      precisionWatch: getPrecisionWatchAdapterStatus(),
      now: new Date().toISOString()
    });
  });

  app.get("/api/provider", (_, response) => {
    response.json(buildProviderStatus());
  });

  app.get("/api/kiwoom/status", (_, response) => {
    const status = getKiwoomEnvStatus();
    response.json({
      ...status,
      source: "local-env",
      bridgeHealthCheck: status.enabled ? "ready-to-check-local-bridge" : "disabled",
      note: status.enabled
        ? "Kiwoom environment is configured. Start the local Kiwoom bridge and register selected watchlist candidates."
        : "Check KIWOOM_ENABLED and KIWOOM_BRIDGE_URL in .env."
    });
  });

  app.get("/api/kis/status", (_, response) => {
    const status = buildProviderStatus().kis;
    response.json({
      ...status,
      source: "local-env",
      note: status?.enabled
        ? "KIS environment is configured and enabled. Token issuance is handled in the next local adapter step."
        : "Check KIS_ENABLED, KIS_APP_KEY, KIS_APP_SEC, and KIS_ACCOUNT_NO in .env."
    });
  });

  app.get("/api/sectors", async (_, response) => {
    try {
      const snapshot = await getMarketSnapshot();
      response.json(withPrecisionWatchlist(snapshot));
    } catch (error) {
      response.status(502).json({ message: "Failed to load market data", error: error.message });
    }
  });

  app.get("/api/precision-watchlist", async (request, response) => {
    try {
      const snapshot = await getMarketSnapshot();
      const limit = Number(request.query.limit || process.env.PRECISION_WATCH_LIMIT || 40);
      response.json(buildPrecisionWatchlist(snapshot, { limit }));
    } catch (error) {
      response.status(502).json({ message: "Failed to build precision watchlist", error: error.message });
    }
  });

  app.get("/api/sectors/:id", async (request, response) => {
    try {
      const snapshot = await getMarketSnapshot();
      const sector = snapshot.sectors.find((item) => item.id === request.params.id);
      if (!sector) {
        response.status(404).json({ message: "Sector not found" });
        return;
      }
      response.json(await getSectorDetail(sector, { force: true }));
    } catch (error) {
      response.status(502).json({ message: "Failed to load sector detail", error: error.message });
    }
  });

  app.post("/api/volume-profile", (request, response) => {
    const stocks = Array.isArray(request.body?.stocks) ? request.body.stocks : [];
    const limit = Number(request.body?.limit || VOLUME_HISTORY_LIMIT);
    response.json(buildVolumeProfile(stocks, limit));
  });

  app.get("/api/stream", async (request, response) => {
    response.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no"
    });

    const sendSnapshot = async () => {
      try {
        const payload = withPrecisionWatchlist(await getMarketSnapshot());
        response.write("event: market\n");
        response.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch (error) {
        response.write("event: error\n");
        response.write(`data: ${JSON.stringify({ message: error.message })}\n\n`);
      }
    };

    await sendSnapshot();
    const interval = setInterval(sendSnapshot, MARKET_CACHE_MS);
    request.on("close", () => clearInterval(interval));
  });

  const vite = await createViteServer({
    appType: "spa",
    server: {
      middlewareMode: true,
      host: "0.0.0.0"
    }
  });

  app.use(vite.middlewares);

  app.use(async (request, response, next) => {
    if (request.method !== "GET") {
      next();
      return;
    }

    try {
      const htmlPath = path.resolve(process.cwd(), "index.html");
      const source = await fs.readFile(htmlPath, "utf8");
      const template = await vite.transformIndexHtml(request.originalUrl, source);
      response.status(200).set({ "Content-Type": "text/html" }).end(template);
    } catch (error) {
      vite.ssrFixStacktrace(error);
      next(error);
    }
  });

  app.listen(PORT, () => {
    console.log(`[server] Moneyboard live server listening on http://localhost:${PORT}`);
    console.log("[server] frontend served by Vite middleware; no dist build required.");
    console.log("[server] precision watchlist: Naver broad scan -> selected broker/API candidates.");
  });
}

main().catch((error) => {
  console.error("[server] failed to start", error);
  process.exit(1);
});
