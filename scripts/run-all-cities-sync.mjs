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
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
import { prunePersistentFetchCache } from "./shared-fetch-state.mjs";
import {
  collectorPerformanceDiagnostics,
  processDiagnostics,
  sourceDiagnostics,
} from "./internal-diagnostics.mjs";

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

function runNode(cwd, args, { env = {} } = {}) {
  return new Promise((resolveRun) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      stdout = `${stdout}${chunk}`.slice(-12_000);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      stderr = `${stderr}${chunk}`.slice(-12_000);
    });
    child.on("error", (error) => resolveRun({ ok: false, stdout, stderr: error.message, code: null, stdoutBytes, stderrBytes, durationMs: Date.now() - startedAt }));
    child.on("close", (code) => resolveRun({ ok: code === 0, stdout, stderr, code, stdoutBytes, stderrBytes, durationMs: Date.now() - startedAt }));
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
  const performance = check.performance;
  const timing = performance
    ? `；耗时 ${(performance.durationMs / 1_000).toFixed(1)} 秒，${performance.logicalRequests} 个逻辑请求、${performance.actualAttempts} 次外部尝试、${performance.sharedCacheHits || 0} 次缓存命中（其中 ${performance.persistentCacheHits || 0} 次持久详情缓存命中）`
    : "";
  return `${sourceName}：${check.status ?? "状态未注明"}；${counts}${timing}。`;
}

export async function runAllCitiesSync({
  collectorsRoot = resolve(projectRoot, "collectors"),
  databasePath = defaultDatabasePath(projectRoot),
  cityIds = CITY_CATALOG.map((city) => city.id),
  onProgress = () => {},
} = {}) {
  const selectedCities = CITY_CATALOG.filter((city) => cityIds.includes(city.id));
  if (!selectedCities.length) throw new Error("没有可执行的城市");
  const workflowStartedAt = Date.now();
  const outcomes = selectedCities.map((city) => ({ cityId: city.id, cityName: city.name, status: "failed", gates: [], error: null }));
  const importedIds = [];
  onProgress({
    phase: "workflow-start",
    message: `开始执行 ${selectedCities.length} 个城市的完整更新。`,
    data: {
      cityCount: selectedCities.length,
      cityIds: selectedCities.map((city) => city.id),
      executionMode: "parallel-cities-shared-host-queue",
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
    },
  });
  const sharedFetchStateDir = await mkdtemp(join(tmpdir(), "menglin-radar-fetch-"));
  const persistentFetchCacheDir = resolve(dirname(databasePath), "fetch-cache");
  const cachePrune = await prunePersistentFetchCache(persistentFetchCacheDir);
  onProgress({ phase: "shared-fetch-ready", message: "四城采集已启用本轮共享缓存、详情持久缓存和全局同域限流。", data: { cityCount: selectedCities.length, persistentCachePolicy: "live-lists-7d-rolling-details-30d-hard-refresh", prunedPersistentEntries: cachePrune.removedEntries } });
  try {
    await Promise.all(selectedCities.map(async (city, cityIndex) => {
      const cityRoot = resolve(collectorsRoot, city.id);
      const outcome = outcomes[cityIndex];
      const cityStartedAt = Date.now();
      outcome.startedAt = new Date(cityStartedAt).toISOString();
      onProgress({ phase: "city-start", cityId: city.id, message: `${city.name}开始执行完整采集工作流。` });
      try {
        await checkCityFolder(cityRoot);
        onProgress({ phase: "city-workflow-start", cityId: city.id, message: `${city.name}采集脚本已启动。` });
        const workflow = await runNode(cityRoot, ["scripts/run-full-workflow.mjs", "--full-update", "--write"], {
          env: { RADAR_SHARED_FETCH_STATE_DIR: sharedFetchStateDir, RADAR_PERSISTENT_FETCH_CACHE_DIR: persistentFetchCacheDir },
        });
        if (!workflow.ok) {
          outcome.error = conciseError(workflow);
          onProgress({ phase: "city-failed", level: "error", cityId: city.id, message: `${city.name}采集脚本失败。`, data: { error: outcome.error, process: processDiagnostics(workflow) } });
          return;
        }
        outcome.workflow = "completed";
        onProgress({ phase: "city-workflow-complete", cityId: city.id, message: `${city.name}采集脚本执行完成，开始读取来源事实记录。`, data: { process: processDiagnostics(workflow) } });
        try {
          const { latestRun, sourceNames } = await readCityFacts(cityRoot);
          if (latestRun) {
            onProgress({
              phase: "city-facts",
              cityId: city.id,
              message: latestRun.summary ?? `${city.name}已生成本轮事实记录。`,
              data: { cityRunId: latestRun.id, checkedAt: latestRun.checkedAt, metrics: latestRun.metrics ?? null, screeningMetrics: latestRun.screeningMetrics ?? null, networkPolicy: latestRun.networkPolicy ?? null },
            });
            const performanceDiagnostics = collectorPerformanceDiagnostics(latestRun.collectorPerformance ?? []);
            onProgress({
              phase: "collector-performance",
              cityId: city.id,
              level: "info",
              message: `${city.name}已生成 ${performanceDiagnostics.collectorCount} 个采集器的性能明细。`,
              data: performanceDiagnostics,
            });
            if (latestRun.networkPolicy) {
              const network = latestRun.networkPolicy;
              onProgress({
                phase: "network-policy",
                cityId: city.id,
                level: network.blocked || network.rateLimited ? "warning" : "info",
                message: `${city.name}请求保护：${network.requests} 个逻辑请求、${network.attempts} 次实际外部请求、${network.sharedCacheHits || 0} 次缓存命中（其中 ${network.persistentCacheHits || 0} 次持久详情缓存命中）、${network.retries} 次重试；服务端限流 ${network.rateLimited} 次，访问控制 ${network.blocked} 次。`,
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
                data: sourceDiagnostics({ ...check, checkedAt: check.checkedAt ?? latestRun.checkedAt ?? null }),
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
          outcome.gates.push({ script, ok: gate.ok, durationMs: gate.durationMs });
          if (!gate.ok) {
            gatesPassed = false;
            outcome.error = `${script}：${conciseError(gate)}`;
            onProgress({ phase: "gate-failed", level: "error", cityId: city.id, message: `${city.name}门禁失败：${script}。`, data: { script, error: outcome.error, process: processDiagnostics(gate) } });
            break;
          }
          onProgress({ phase: "gate-passed", level: "success", cityId: city.id, message: `${city.name}门禁通过：${script}（${gate.durationMs} 毫秒）。`, data: { script, process: processDiagnostics(gate) } });
        }
        if (!gatesPassed) {
          onProgress({ phase: "city-failed", level: "error", cityId: city.id, message: `${city.name}未通过全部门禁，本轮不导入。`, data: { error: outcome.error } });
          return;
        }
        outcome.status = "ready-to-import";
        importedIds.push(city.id);
        onProgress({ phase: "city-ready", level: "success", cityId: city.id, message: `${city.name}采集与门禁均已完成，等待导入。` });
      } catch (error) {
        outcome.error = error instanceof Error ? error.message : "城市工作流异常终止";
        onProgress({ phase: "city-failed", level: "error", cityId: city.id, message: `${city.name}工作流异常终止。`, data: { error: outcome.error } });
      } finally {
        outcome.completedAt = new Date().toISOString();
        outcome.durationMs = Date.now() - cityStartedAt;
        onProgress({
          phase: "city-finished",
          level: outcome.status === "ready-to-import" ? "success" : "warning",
          cityId: city.id,
          message: `${city.name}城市阶段结束，耗时 ${(outcome.durationMs / 1_000).toFixed(1)} 秒。`,
          data: { status: outcome.status, durationMs: outcome.durationMs, gateCount: outcome.gates.length, error: outcome.error },
        });
      }
    }));
  } finally {
    const cleanupStartedAt = Date.now();
    await rm(sharedFetchStateDir, { recursive: true, force: true });
    onProgress({ phase: "shared-fetch-cleanup", message: "共享请求缓存已清理。", data: { durationMs: Date.now() - cleanupStartedAt } });
  }

  importedIds.sort((left, right) => cityIds.indexOf(left) - cityIds.indexOf(right));

  let imported = [];
  if (importedIds.length) {
    const importStartedAt = Date.now();
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
    onProgress({ phase: "import-complete", level: "success", message: `统一数据库导入完成，耗时 ${Date.now() - importStartedAt} 毫秒。`, data: { durationMs: Date.now() - importStartedAt, cityIds: importedIds, imported } });
  }
  const retentionStartedAt = Date.now();
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
    data: { ...retention, durationMs: Date.now() - retentionStartedAt },
  });
  const completedAt = new Date().toISOString();
  const summary = {
    startedAt: new Date(workflowStartedAt).toISOString(),
    startedCityCount: selectedCities.length,
    importedCityCount: importedIds.length,
    failedCityCount: outcomes.length - importedIds.length,
    outcomes,
    imported,
    retention,
    completedAt,
    durationMs: Date.now() - workflowStartedAt,
  };
  onProgress({ phase: "workflow-complete", level: summary.failedCityCount ? "warning" : "success", message: `完整更新执行结束：导入 ${summary.importedCityCount} 个城市，失败 ${summary.failedCityCount} 个城市，总耗时 ${(summary.durationMs / 1_000).toFixed(1)} 秒。`, data: { importedCityCount: summary.importedCityCount, failedCityCount: summary.failedCityCount, durationMs: summary.durationMs, outcomes: outcomes.map(({ cityId, status, durationMs, gates, error }) => ({ cityId, status, durationMs, gates, error })) } });
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
