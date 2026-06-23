import express from "express";
import { createServer as createViteServer } from "vite";
import { buildVolumeProfile, getMarketSnapshot, getSectorDetail } from "../server.js";
import { buildPrecisionWatchlist, getPrecisionWatchAdapterStatus } from "../server-precision-watch.js";

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
    response.json({
      market: "Naver Finance broad scan",
      sectorDetail: "Naver Finance",
      overviewProvider: "Yahoo Finance",
      volumeProfile: "Naver Finance day-volume only",
      precisionWatch: {
        broadScan: "Naver Finance all-sector scan",
        selectedUniverse: "top-ranked candidates only",
        endpoint: "/api/precision-watchlist",
        adapter: getPrecisionWatchAdapterStatus()
      },
      kis: { configured: false, enabled: false }
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
      const template = await vite.transformIndexHtml(request.originalUrl, await vite.ssrLoadModule("/index.html?raw").then((module) => module.default));
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
