#!/usr/bin/env node
/**
 * Unified, failure-isolated city refresh.
 *
 * Each city owns its source recipes and collector runtime.  This runner only
 * coordinates those four independent full workflows, runs their publication
 * gates, and imports every successful snapshot into the shared SQLite store.
 * A problem in one city is recorded in the result but never stops the other
 * three from running.
 */
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CITY_CATALOG, defaultDatabasePath } from "../db.mjs";
import { importLegacyCities } from "./import-legacy-cities.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const cityValidationScripts = [
  "scripts/validate-source-plan.mjs",
  "scripts/validate-screening-policy.mjs",
  "scripts/validate-review-log.mjs",
  "scripts/validate-data.mjs",
  "scripts/check-privacy.mjs",
];

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function runNode(cwd, args) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-12_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-12_000); });
    child.on("error", (error) => resolveRun({ ok: false, stdout, stderr: error.message, code: null }));
    child.on("close", (code) => resolveRun({ ok: code === 0, stdout, stderr, code }));
  });
}

function conciseError(result) {
  const output = `${result.stderr}\n${result.stdout}`.trim();
  return output ? output.split("\n").slice(-6).join("\n") : `进程以 ${result.code ?? "未知"} 退出`;
}

async function checkCityFolder(cityRoot) {
  await access(resolve(cityRoot, "scripts", "run-full-workflow.mjs"), constants.R_OK);
}

export async function runAllCitiesSync({
  legacyRoot = resolve(projectRoot, ".."),
  databasePath = defaultDatabasePath(projectRoot),
  cityIds = CITY_CATALOG.map((city) => city.id),
  onProgress = () => {},
} = {}) {
  const selectedCities = CITY_CATALOG.filter((city) => cityIds.includes(city.id));
  if (!selectedCities.length) throw new Error("没有可执行的城市");
  const outcomes = [];
  const importedIds = [];

  for (const city of selectedCities) {
    const cityRoot = resolve(legacyRoot, `${city.id}-opportunity-radar-public`);
    const outcome = { cityId: city.id, cityName: city.name, status: "failed", gates: [], error: null };
    outcomes.push(outcome);
    onProgress({ phase: "city-start", cityId: city.id });
    try {
      await checkCityFolder(cityRoot);
      const workflow = await runNode(cityRoot, ["scripts/run-full-workflow.mjs", "--full-update", "--write"]);
      if (!workflow.ok) {
        outcome.error = conciseError(workflow);
        onProgress({ phase: "city-failed", cityId: city.id, error: outcome.error });
        continue;
      }
      outcome.workflow = "completed";
      let gatesPassed = true;
      for (const script of cityValidationScripts) {
        const gate = await runNode(cityRoot, [script]);
        outcome.gates.push({ script, ok: gate.ok });
        if (!gate.ok) {
          gatesPassed = false;
          outcome.error = `${script}：${conciseError(gate)}`;
          break;
        }
      }
      if (!gatesPassed) {
        onProgress({ phase: "city-failed", cityId: city.id, error: outcome.error });
        continue;
      }
      outcome.status = "ready-to-import";
      importedIds.push(city.id);
      onProgress({ phase: "city-ready", cityId: city.id });
    } catch (error) {
      outcome.error = error instanceof Error ? error.message : "城市工作流异常终止";
      onProgress({ phase: "city-failed", cityId: city.id, error: outcome.error });
    }
  }

  let imported = [];
  if (importedIds.length) {
    imported = await importLegacyCities({ legacyRoot, databasePath, cityIds: importedIds });
    for (const outcome of outcomes) {
      if (outcome.status === "ready-to-import") outcome.status = "imported";
    }
  }
  const completedAt = new Date().toISOString();
  const summary = {
    startedCityCount: selectedCities.length,
    importedCityCount: importedIds.length,
    failedCityCount: outcomes.length - importedIds.length,
    outcomes,
    imported,
    completedAt,
  };
  onProgress({ phase: "complete", summary });
  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const legacyRoot = argument("--from") ?? process.env.RADAR_LEGACY_ROOT ?? resolve(projectRoot, "..");
  const databasePath = argument("--database") ?? process.env.RADAR_DB_PATH ?? defaultDatabasePath(projectRoot);
  const city = argument("--city");
  const summary = await runAllCitiesSync({
    legacyRoot,
    databasePath,
    cityIds: city ? [city] : CITY_CATALOG.map((item) => item.id),
    onProgress: ({ phase, cityId }) => { if (cityId) console.log(`${phase}: ${cityId}`); },
  });
  console.log(JSON.stringify(summary, null, 2));
  if (summary.failedCityCount) process.exitCode = 1;
}
