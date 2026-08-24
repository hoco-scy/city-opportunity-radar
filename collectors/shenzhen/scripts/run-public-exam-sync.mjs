#!/usr/bin/env node
/**
 * Runs the registered script-backed civil-exam and selection-program sources and records an
 * anonymous, targeted remediation. It never publishes a position directly;
 * publishing requires a separate private eligibility decision for every row.
 */
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { collectPublicExamWorkflowSources, summarizePublicExamOutcomes } from "./public-exam-workflow.mjs";

const root = new URL("../", import.meta.url);

function shanghaiMinute() {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(new Date()).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00+08:00`;
}

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, root), "utf8"));
}

export async function buildPublicExamRun({ registry, recipes, checkedAt, fetchImpl = fetch } = {}) {
  const outcomes = await collectPublicExamWorkflowSources({ registry, recipes, fetchImpl });
  if (!outcomes.length) throw new Error("本仓库没有登记为 primary: script 的公务员考试或选调优培采集来源，不能生成同步记录。");
  const summary = summarizePublicExamOutcomes(outcomes);
  const sourceChecks = outcomes.map((outcome) => ({ ...outcome.sourceCheck, checkedAt }));
  const reviews = outcomes.flatMap((outcome) => outcome.reviews);
  const incomplete = sourceChecks.filter((check) => ["accessible-incomplete", "temporarily-unavailable", "semantic-404", "failed"].includes(check.status)).length;
  return {
    id: `run-${checkedAt.slice(0, 10).replaceAll("-", "")}-${checkedAt.slice(11, 16).replace(":", "")}-public-exam-sync`,
    scope: "targeted-remediation",
    checkedAt,
    trigger: "public-exam-script-sync",
    policyVersion: 6,
    screeningStrategyVersion: 2,
    candidateProcessingVersion: 3,
    coverageStatus: "targeted-public-exam-sources",
    status: incomplete ? "completed-partial" : "completed",
    outcome: "official-public-exam-announcements-synchronized",
    summary: `已用脚本完成 ${summary.sources} 个登记公务员考试与选调优培来源的官方公告、详情和可公开附件检查；发现 ${summary.notices} 条公告，${summary.deferred} 条仍需私有资格判断的公告级待核验对象。未将任何具体岗位直接发布到岗位页。`,
    metrics: {
      officialSystemsChecked: sourceChecks.length,
      officialSystemsSucceeded: sourceChecks.length - incomplete,
      officialSystemsFailed: incomplete,
      newLeads: summary.notices,
      reviewedItems: reviews.length,
      accepted: 0,
      rejected: 0,
      deferred: reviews.length,
      published: 0,
      updated: 0,
      closed: 0
    },
    screeningMetrics: {
      portalResultsReported: summary.notices,
      nativeFilterQueries: summary.sources,
      nativeFilteredResults: summary.notices,
      deduplicatedCandidates: reviews.length,
      positionsBatchReviewed: reviews.length,
      positionsOfficiallyVerified: 0,
      positionsEscalated: 0,
      positionsDeferredByBudget: 0,
      discoverySourcesChecked: 0,
      discoveryOfficialCandidates: 0
    },
    sourceChecks,
    reviews
  };
}

async function main() {
  const write = process.argv.includes("--write");
  const [registry, recipes, log, opportunities] = await Promise.all([
    readJson("data/source-registry.json"),
    readJson("data/filter-recipes.json"),
    readJson("data/review-log.json"),
    readJson("data/opportunities.json")
  ]);
  const checkedAt = shanghaiMinute();
  const run = await buildPublicExamRun({ registry, recipes, checkedAt });
  if (!write) {
    console.log(JSON.stringify({ dryRun: true, city: recipes.city, run }, null, 2));
    return;
  }
  log.meta.initializationStatus = "synchronized";
  log.meta.lastRunAt = checkedAt;
  log.runs = log.runs.filter((previous) => previous.id !== run.id);
  log.runs.unshift(run);
  opportunities.meta.initializationStatus = "synchronized";
  opportunities.meta.lastVerifiedAt = checkedAt;
  opportunities.meta.lastRunStatus = run.status;
  opportunities.meta.lastIncompleteSourceCount = run.metrics.officialSystemsFailed;
  opportunities.meta.lastDeferredCandidateCount = run.metrics.deferred;
  await Promise.all([
    writeFile(new URL("data/review-log.json", root), `${JSON.stringify(log, null, 2)}\n`),
    writeFile(new URL("data/opportunities.json", root), `${JSON.stringify(opportunities, null, 2)}\n`)
  ]);
  console.log(JSON.stringify({ written: true, city: recipes.city, sourceChecks: run.sourceChecks.length, deferred: run.metrics.deferred, incomplete: run.metrics.officialSystemsFailed }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: "public-exam-sync-failed", error: error.message }, null, 2));
    process.exitCode = 1;
  });
}
