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
import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireUpdateLock,
  appendUpdateEvent,
  CITY_CATALOG,
  closeDatabase,
  defaultDatabasePath,
  finishUpdateRun,
  heartbeatUpdateLock,
  openRadarDatabase,
  prunePublicRetention,
} from "../db.mjs";
import { importCityCollectors } from "./import-city-collectors.mjs";

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

async function readCityFacts(cityRoot) {
  const [reviewLog, registry] = await Promise.all([
    readFile(resolve(cityRoot, "data", "review-log.json"), "utf8").then(JSON.parse),
    readFile(resolve(cityRoot, "data", "source-registry.json"), "utf8").then(JSON.parse),
  ]);
  const latestRun = [...(reviewLog.runs ?? [])].sort((left, right) => String(right.checkedAt ?? "").localeCompare(String(left.checkedAt ?? "")))[0] ?? null;
  const sourceNames = new Map((registry.sources ?? []).map((source) => [source.id, source.collectionOrganization ?? source.organization ?? source.id]));
  return { latestRun, sourceNames };
}

function sourceFactMessage(check, sourceName) {
  const metrics = check.collectionMetrics;
  const counts = metrics && Number.isInteger(metrics.collected) && Number.isInteger(metrics.afterFilter)
    ? `采集 ${metrics.collected} 条，筛选后 ${metrics.afterFilter} 条`
    : "本轮未形成可计数的采集结果";
  return `${sourceName}：${check.status ?? "状态未注明"}；${counts}。`;
}

export async function runAllCitiesSync({
  collectorsRoot = resolve(projectRoot, "collectors"),
  databasePath = defaultDatabasePath(projectRoot),
  cityIds = CITY_CATALOG.map((city) => city.id),
  onProgress = () => {},
} = {}) {
  const selectedCities = CITY_CATALOG.filter((city) => cityIds.includes(city.id));
  if (!selectedCities.length) throw new Error("没有可执行的城市");
  const outcomes = [];
  const importedIds = [];
  onProgress({ phase: "workflow-start", message: `开始执行 ${selectedCities.length} 个城市的完整更新。`, data: { cityCount: selectedCities.length } });

  for (const city of selectedCities) {
    const cityRoot = resolve(collectorsRoot, city.id);
    const outcome = { cityId: city.id, cityName: city.name, status: "failed", gates: [], error: null };
    outcomes.push(outcome);
    onProgress({ phase: "city-start", cityId: city.id, message: `${city.name}开始执行完整采集工作流。` });
    try {
      await checkCityFolder(cityRoot);
      onProgress({ phase: "city-workflow-start", cityId: city.id, message: `${city.name}采集脚本已启动。` });
      const workflow = await runNode(cityRoot, ["scripts/run-full-workflow.mjs", "--full-update", "--write"]);
      if (!workflow.ok) {
        outcome.error = conciseError(workflow);
        onProgress({ phase: "city-failed", level: "error", cityId: city.id, message: `${city.name}采集脚本失败。`, data: { error: outcome.error } });
        continue;
      }
      outcome.workflow = "completed";
      onProgress({ phase: "city-workflow-complete", cityId: city.id, message: `${city.name}采集脚本执行完成，开始读取来源事实记录。` });
      try {
        const { latestRun, sourceNames } = await readCityFacts(cityRoot);
        if (latestRun) {
          onProgress({
            phase: "city-facts",
            cityId: city.id,
            message: latestRun.summary ?? `${city.name}已生成本轮事实记录。`,
            data: { cityRunId: latestRun.id, checkedAt: latestRun.checkedAt, metrics: latestRun.metrics ?? null, screeningMetrics: latestRun.screeningMetrics ?? null, networkPolicy: latestRun.networkPolicy ?? null },
          });
          if (latestRun.networkPolicy) {
            const network = latestRun.networkPolicy;
            onProgress({
              phase: "network-policy",
              cityId: city.id,
              level: network.blocked || network.rateLimited ? "warning" : "info",
              message: `${city.name}请求保护：${network.requests} 个逻辑请求、${network.retries} 次重试、${network.throttledWaits} 次限流等待；服务端限流 ${network.rateLimited} 次，访问控制 ${network.blocked} 次。`,
              data: { networkPolicy: network },
            });
          }
          for (const check of latestRun.sourceChecks ?? []) {
            const sourceName = sourceNames.get(check.sourceId) ?? check.sourceId;
            onProgress({
              phase: "source-check",
              level: ["unavailable", "failed", "error"].some((word) => String(check.status).includes(word)) ? "warning" : "info",
              cityId: city.id,
              sourceId: check.sourceId,
              message: sourceFactMessage(check, sourceName),
              data: {
                status: check.status ?? null,
                attempts: check.attempts ?? null,
                checkedAt: check.checkedAt ?? latestRun.checkedAt ?? null,
                collectionMetrics: check.collectionMetrics ?? null,
                note: check.note ?? null,
              },
            });
          }
        }
      } catch (factError) {
        onProgress({ phase: "city-facts-unavailable", level: "warning", cityId: city.id, message: `${city.name}事实记录暂时无法读取。`, data: { error: factError instanceof Error ? factError.message : "未知错误" } });
      }
      let gatesPassed = true;
      for (const script of cityValidationScripts) {
        onProgress({ phase: "gate-start", cityId: city.id, message: `${city.name}开始执行门禁：${script}。`, data: { script } });
        const gate = await runNode(cityRoot, [script]);
        outcome.gates.push({ script, ok: gate.ok });
        if (!gate.ok) {
          gatesPassed = false;
          outcome.error = `${script}：${conciseError(gate)}`;
          onProgress({ phase: "gate-failed", level: "error", cityId: city.id, message: `${city.name}门禁失败：${script}。`, data: { script, error: outcome.error } });
          break;
        }
        onProgress({ phase: "gate-passed", level: "success", cityId: city.id, message: `${city.name}门禁通过：${script}。`, data: { script } });
      }
      if (!gatesPassed) {
        onProgress({ phase: "city-failed", level: "error", cityId: city.id, message: `${city.name}未通过全部门禁，本轮不导入。`, data: { error: outcome.error } });
        continue;
      }
      outcome.status = "ready-to-import";
      importedIds.push(city.id);
      onProgress({ phase: "city-ready", level: "success", cityId: city.id, message: `${city.name}采集与门禁均已完成，等待导入。` });
    } catch (error) {
      outcome.error = error instanceof Error ? error.message : "城市工作流异常终止";
      onProgress({ phase: "city-failed", level: "error", cityId: city.id, message: `${city.name}工作流异常终止。`, data: { error: outcome.error } });
    }
  }

  let imported = [];
  if (importedIds.length) {
    onProgress({ phase: "import-start", message: `开始把 ${importedIds.length} 个城市的快照导入统一数据库。`, data: { cityIds: importedIds } });
    imported = await importCityCollectors({ collectorsRoot, databasePath, cityIds: importedIds });
    for (const outcome of outcomes) {
      if (outcome.status === "ready-to-import") outcome.status = "imported";
    }
    for (const item of imported) {
      const cityName = CITY_CATALOG.find((city) => city.id === item.cityId)?.name ?? item.cityId;
      onProgress({
        phase: "city-imported",
        level: "success",
        cityId: item.cityId,
        message: `${cityName}已导入：${item.jobs} 条官方核验岗位、${item.candidates} 条可信来源岗位、${item.monitors} 条公告。`,
        data: item,
      });
    }
  }
  const retentionDb = openRadarDatabase(databasePath);
  let retention;
  try {
    retention = prunePublicRetention(retentionDb);
  } finally {
    closeDatabase(retentionDb);
  }
  onProgress({
    phase: "retention-complete",
    level: "success",
    message: `最近六个月保留规则已执行，本轮清理 ${retention.deletedOpportunities} 条过期信息。`,
    data: retention,
  });
  const completedAt = new Date().toISOString();
  const summary = {
    startedCityCount: selectedCities.length,
    importedCityCount: importedIds.length,
    failedCityCount: outcomes.length - importedIds.length,
    outcomes,
    imported,
    retention,
    completedAt,
  };
  onProgress({ phase: "workflow-complete", level: summary.failedCityCount ? "warning" : "success", message: `完整更新执行结束：导入 ${summary.importedCityCount} 个城市，失败 ${summary.failedCityCount} 个城市。`, data: { importedCityCount: summary.importedCityCount, failedCityCount: summary.failedCityCount } });
  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const collectorsRoot = argument("--from") ?? process.env.RADAR_COLLECTORS_ROOT ?? resolve(projectRoot, "collectors");
  const databasePath = argument("--database") ?? process.env.RADAR_DB_PATH ?? defaultDatabasePath(projectRoot);
  const city = argument("--city");
  const db = openRadarDatabase(databasePath);
  const runId = `update_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomUUID().slice(0, 8)}`;
  const lock = acquireUpdateLock(db, { runId, trigger: "cli", requestedBy: "sync:all-cities" });
  if (!lock.acquired) {
    console.log(`已有更新正在运行（${lock.run?.runId ?? "未知运行"}），本次没有启动第二个请求。`);
    db.close();
  } else {
    const heartbeat = setInterval(() => heartbeatUpdateLock(db, runId), 30_000);
    heartbeat.unref?.();
    try {
      const summary = await runAllCitiesSync({
        collectorsRoot,
        databasePath,
        cityIds: city ? [city] : CITY_CATALOG.map((item) => item.id),
        onProgress: (event) => {
          appendUpdateEvent(db, runId, event);
          console.log(`${event.occurredAt ?? new Date().toISOString()} ${event.cityId ? `${event.cityId} ` : ""}${event.message}`);
        },
      });
      finishUpdateRun(db, runId, { state: summary.failedCityCount ? "completed-partial" : "completed", summary });
      console.log(JSON.stringify(summary, null, 2));
      if (summary.failedCityCount) process.exitCode = 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "统一更新失败";
      finishUpdateRun(db, runId, { state: "failed", error: message });
      console.error(message);
      process.exitCode = 1;
    } finally {
      clearInterval(heartbeat);
      db.close();
    }
  }
}
