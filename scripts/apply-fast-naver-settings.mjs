import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function patchFile(relativePath, replacements) {
  const filePath = path.join(rootDir, relativePath);
  if (!existsSync(filePath)) {
    console.log(`[fast-settings] skip missing ${relativePath}`);
    return;
  }

  let content = readFileSync(filePath, "utf8");
  let changed = false;

  for (const { label, pattern, replacement } of replacements) {
    if (!pattern.test(content)) {
      console.log(`[fast-settings] ${relativePath}: ${label} already patched or not found`);
      continue;
    }
    content = content.replace(pattern, replacement);
    changed = true;
  }

  if (changed) {
    writeFileSync(filePath, content, "utf8");
    console.log(`[fast-settings] patched ${relativePath}`);
  } else {
    console.log(`[fast-settings] ${relativePath} unchanged`);
  }
}

patchFile("server.js", [
  {
    label: "market cache 5s",
    pattern: /const MARKET_CACHE_MS = Number\(process\.env\.MARKET_CACHE_MS \|\| [\d_]+\);/,
    replacement: "const MARKET_CACHE_MS = Number(process.env.MARKET_CACHE_MS || 5_000);"
  },
  {
    label: "detail cache 5s",
    pattern: /const DETAIL_CACHE_MS = Number\(process\.env\.DETAIL_CACHE_MS \|\| [\d_]+\);/,
    replacement: "const DETAIL_CACHE_MS = Number(process.env.DETAIL_CACHE_MS || 5_000);"
  },
  {
    label: "request timeout 8s",
    pattern: /const REQUEST_TIMEOUT_MS = Number\(process\.env\.REQUEST_TIMEOUT_MS \|\| [\d_]+\);/,
    replacement: "const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 8_000);"
  },
  {
    label: "detail concurrency 16",
    pattern: /const DETAIL_CONCURRENCY = Number\(process\.env\.DETAIL_CONCURRENCY \|\| [\d_]+\);/,
    replacement: "const DETAIL_CONCURRENCY = Number(process.env.DETAIL_CONCURRENCY || 16);"
  }
]);

patchFile("src/App.jsx", [
  {
    label: "api fallback poll 3s",
    pattern: /const apiFallbackPollMs = [\d_]+;/,
    replacement: "const apiFallbackPollMs = 3_000;"
  },
  {
    label: "pages failure retry 5s",
    pattern: /const pagesLiveFailureRetryMs = [\d_]+;/,
    replacement: "const pagesLiveFailureRetryMs = 5_000;"
  }
]);

console.log("[fast-settings] Naver/Yahoo fast refresh mode: market=5s, detail=5s, fallback poll=3s, concurrency=16");
