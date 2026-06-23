import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distIndex = path.join(rootDir, "dist", "index.html");
const packageJson = path.join(rootDir, "package.json");
const srcDir = path.join(rootDir, "src");
const publicIndex = path.join(rootDir, "index.html");

function newestMtime(targetPath) {
  if (!existsSync(targetPath)) return 0;
  const stat = statSync(targetPath);
  if (stat.isFile()) return stat.mtimeMs;
  if (!stat.isDirectory()) return stat.mtimeMs;

  let newest = stat.mtimeMs;
  const entries = spawnSync(process.execPath, [
    "-e",
    `const fs=require('fs'); const path=require('path'); const root=${JSON.stringify(targetPath)}; let n=0; function walk(p){ for(const e of fs.readdirSync(p,{withFileTypes:true})){ const fp=path.join(p,e.name); const s=fs.statSync(fp); n=Math.max(n,s.mtimeMs); if(e.isDirectory()) walk(fp); } } walk(root); console.log(n);`
  ], { encoding: "utf8" });
  const parsed = Number(String(entries.stdout || "").trim());
  if (Number.isFinite(parsed)) newest = Math.max(newest, parsed);
  return newest;
}

function shouldBuild() {
  if (!existsSync(distIndex)) return "dist/index.html missing";
  const distTime = newestMtime(distIndex);
  const sourceTime = Math.max(newestMtime(packageJson), newestMtime(srcDir), newestMtime(publicIndex));
  if (sourceTime > distTime) return "frontend source changed after last build";
  return "";
}

const reason = shouldBuild();
if (!reason) {
  console.log("[preflight] dist/index.html exists. Skipping frontend build.");
  process.exit(0);
}

console.log(`[preflight] ${reason}. Running vite build once...`);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npmCommand, ["run", "build"], {
  cwd: rootDir,
  stdio: "inherit",
  shell: false
});

if (result.status !== 0) {
  console.error("[preflight] Frontend build failed. Server will not start.");
  process.exit(result.status || 1);
}

console.log("[preflight] Frontend build complete.");
