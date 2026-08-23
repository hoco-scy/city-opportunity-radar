import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CITY_CATALOG, closeDatabase, defaultDatabasePath, openRadarDatabase, replaceCitySnapshot } from "../db.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

export async function importLegacyCities({
  legacyRoot = resolve(projectRoot, ".."),
  databasePath = defaultDatabasePath(projectRoot),
  cityIds = CITY_CATALOG.map((city) => city.id),
} = {}) {
  const db = openRadarDatabase(databasePath);
  try {
    const summary = [];
    for (const cityId of cityIds) {
      const sourceRoot = resolve(legacyRoot, `${cityId}-opportunity-radar-public`, "data");
      const [opportunities, registry, reviewLog] = await Promise.all([
        readJson(resolve(sourceRoot, "opportunities.json")),
        readJson(resolve(sourceRoot, "source-registry.json")),
        readJson(resolve(sourceRoot, "review-log.json")),
      ]);
      replaceCitySnapshot(db, { cityId, opportunities, registry, reviewLog });
      summary.push({
        cityId,
        jobs: opportunities.jobs?.length ?? 0,
        candidates: opportunities.candidates?.length ?? 0,
        monitors: opportunities.monitors?.length ?? 0,
        sources: registry.sources?.length ?? 0,
        runs: reviewLog.runs?.length ?? 0,
      });
    }
    return summary;
  } finally {
    closeDatabase(db);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const legacyRoot = argument("--from") ?? resolve(projectRoot, "..");
  const databasePath = argument("--database") ?? defaultDatabasePath(projectRoot);
  const city = argument("--city");
  const summary = await importLegacyCities({
    legacyRoot,
    databasePath,
    cityIds: city ? [city] : CITY_CATALOG.map((item) => item.id),
  });
  console.log(`已导入 ${summary.length} 个城市的公开数据：`);
  for (const item of summary) console.log(`- ${item.cityId}：${item.jobs} 个已核验岗位、${item.candidates} 条待用户确认线索、${item.monitors} 个公告、${item.sources} 个信息源、${item.runs} 次更新记录`);
}
