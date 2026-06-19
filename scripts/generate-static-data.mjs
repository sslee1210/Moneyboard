import { mkdir, writeFile } from "node:fs/promises";
import { getMarketSnapshot, getSectorDetail } from "../server.js";

const outDir = new URL("../public/data/", import.meta.url);
const sectorDir = new URL("./sectors/", outDir);

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

await mkdir(sectorDir, { recursive: true });

const snapshot = await getMarketSnapshot();
const details = await mapLimit(snapshot.sectors, 8, (sector) => getSectorDetail(sector));

await writeFile(
  new URL("./market.json", outDir),
  JSON.stringify(
    {
      ...snapshot,
      mode: "static-pages-snapshot",
      generatedAt: new Date().toISOString()
    },
    null,
    2
  )
);

await Promise.all(
  details.map((detail) =>
    writeFile(new URL(`./sectors/${detail.id}.json`, outDir), JSON.stringify(detail, null, 2))
  )
);

console.log(`Generated static Pages data for ${snapshot.sectors.length} sectors.`);
