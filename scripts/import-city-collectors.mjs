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

export async function importCityCollectors({
  collectorsRoot = resolve(projectRoot, "collectors"),
  databasePath = defaultDatabasePath(projectRoot),
  cityIds = CITY_CATALOG.map((city) => city.id),
} = {}) {
  const db = openRadarDatabase(databasePath);
  try {
    const summary = [];
    for (const cityId of cityIds) {
      const sourceRoot = resolve(collectorsRoot, cityId, "data");
      const [opportunities, registry, reviewLog] = await Promise.all([
        readJson(resolve(sourceRoot, "opportunities.json")),
        readJson(resolve(sourceRoot, "source-registry.json")),
        readJson(resolve(sourceRoot, "review-log.json")),
      ]);
      replaceCitySnapshot(db, { cityId, opportunities, registry, reviewLog });
      const importedCounts = Object.fromEntries(db.prepare(`
        SELECT record_type AS recordType, COUNT(*) AS count
        FROM opportunities WHERE city_id = ? GROUP BY record_type
      `).all(cityId).map((row) => [row.recordType, Number(row.count)]));
      const importedRuns = Number(db.prepare("SELECT COUNT(*) AS count FROM sync_runs WHERE city_id = ?").get(cityId).count);
      summary.push({
        cityId,
        jobs: importedCounts.job ?? 0,
        candidates: importedCounts.candidate ?? 0,
        monitors: importedCounts.monitor ?? 0,
        sources: registry.sources?.length ?? 0,
        runs: importedRuns,
      });
    }
    return summary;
  } finally {
    closeDatabase(db);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const collectorsRoot = argument("--from") ?? process.env.RADAR_COLLECTORS_ROOT ?? resolve(projectRoot, "collectors");
  const databasePath = argument("--database") ?? defaultDatabasePath(projectRoot);
  const city = argument("--city");
  const summary = await importCityCollectors({
    collectorsRoot,
    databasePath,
    cityIds: city ? [city] : CITY_CATALOG.map((item) => item.id),
  });
  console.log(`已导入 ${summary.length} 个城市的公开数据：`);
  for (const item of summary) console.log(`- ${item.cityId}：${item.jobs} 个官方核验岗位、${item.candidates} 条可信来源岗位、${item.monitors} 个公告、${item.sources} 个信息源、${item.runs} 次更新记录`);
}
