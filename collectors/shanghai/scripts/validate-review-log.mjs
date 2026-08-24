import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const opportunities = JSON.parse(await readFile(new URL("data/opportunities.json", root), "utf8"));
const log = JSON.parse(await readFile(new URL("data/review-log.json", root), "utf8"));
const registry = JSON.parse(await readFile(new URL("data/source-registry.json", root), "utf8"));
const sourcePlan = JSON.parse(await readFile(new URL("data/source-plan.json", root), "utf8"));
const sources = new Map(registry.sources.map((source) => [source.id, source]));
const everyRunOfficial = new Set(sourcePlan.coverage?.everyRunOfficial || []);
const everyRunDiscovery = new Set(sourcePlan.coverage?.everyRunDiscovery || []);
const errors = [];
const minuteTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/;
const decisions = new Set(["accepted", "rejected", "deferred"]);
const runStatuses = new Set(["completed", "completed-partial", "failed", "not-started"]);
const sourceCheckStatuses = new Set([
  "checked-deferred", "checked-full-pagination", "checked-native-filtered", "checked-browser-route",
  "checked-official-notice-feed", "checked-no-active-campaign", "checked-no-new-position-table",
  "checked-no-publishable-change", "checked-roster-current",
  "accessible-incomplete", "temporarily-unavailable", "semantic-404", "failed"
]);
const incompleteSourceStatuses = new Set(["accessible-incomplete", "temporarily-unavailable", "semantic-404", "failed"]);
const nativeFilterMetricKeys = [
  "portalResultsReported", "nativeFilterQueries", "nativeFilteredResults", "deduplicatedCandidates",
  "positionsBatchReviewed", "positionsOfficiallyVerified",
  "positionsEscalated", "positionsDeferredByBudget"
];
const legacyScreeningMetricKeys = [
  "datasetsDownloaded", "datasetsReused", "positionsDiscovered", "positionsMachineScreened",
  "positionsMachineRejected", "positionsBatchReviewed", "positionsOfficiallyVerified",
  "positionsEscalated", "positionsDeferredByBudget"
];

function officialDomain(urlValue, source) {
  try {
    const url = new URL(urlValue);
    const permittedProtocol = url.protocol === "https:" || (["official-http-only", "official-http-fallback"].includes(source.transportSecurity) && url.protocol === "http:");
    const domains = [...source.domains];
    if (source.collectionEntryUrl) domains.push(new URL(source.collectionEntryUrl).hostname);
    return permittedProtocol && domains.some((domain) =>
      url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch { return false; }
}

const awaitingFirstSync = log.meta?.initializationStatus === "awaiting-first-sync";
if (log.meta?.schemaVersion !== 1) errors.push("review-log meta.schemaVersion 必须为 1");
if (awaitingFirstSync) {
  if (log.meta?.lastRunAt !== null || opportunities.meta?.lastVerifiedAt !== null) errors.push("首次同步前不得伪造核验时间");
  if (opportunities.meta?.initializationStatus !== "awaiting-first-sync") errors.push("两个数据文件必须一致标记首次同步状态");
  if (!Array.isArray(log.runs) || log.runs.length) errors.push("首次同步前不应生成审核运行记录");
} else {
  if (!minuteTimestamp.test(log.meta?.lastRunAt || "")) errors.push("review-log meta.lastRunAt 必须精确到北京时间分钟");
  if (log.meta?.lastRunAt !== opportunities.meta?.lastVerifiedAt) errors.push("最近核验时间与审核日志最后运行时间不一致");
  if (!Array.isArray(log.runs) || !log.runs.length) errors.push("review-log.runs 至少需要一轮记录");
  if (log.runs?.[0]?.checkedAt !== log.meta?.lastRunAt) errors.push("最新一轮日志必须与 meta.lastRunAt 一致并排在首位");
}

const runIds = new Set();
const reviewIds = new Set();
for (const [runIndex, run] of (log.runs || []).entries()) {
  const label = `runs[${runIndex}]`;
  for (const key of ["id", "checkedAt", "trigger", "status", "outcome", "summary", "metrics", "sourceChecks", "reviews"]) {
    if (run[key] === undefined || run[key] === null || run[key] === "") errors.push(`${label}.${key} 缺失`);
  }
  if (runIds.has(run.id)) errors.push(`${label}.id 重复`);
  runIds.add(run.id);
  if (!minuteTimestamp.test(run.checkedAt || "")) errors.push(`${label}.checkedAt 必须精确到北京时间分钟`);
  if (!runStatuses.has(run.status)) errors.push(`${label}.status 不受支持`);

  const metrics = run.metrics || {};
  for (const key of ["officialSystemsChecked", "officialSystemsSucceeded", "officialSystemsFailed", "newLeads", "reviewedItems", "accepted", "rejected", "deferred", "published", "updated", "closed"]) {
    if (!Number.isInteger(metrics[key]) || metrics[key] < 0) errors.push(`${label}.metrics.${key} 必须是非负整数`);
  }
  if (metrics.officialSystemsSucceeded + metrics.officialSystemsFailed !== metrics.officialSystemsChecked) errors.push(`${label} 官方来源成功与失败数量不闭合`);
  if (metrics.accepted + metrics.rejected + metrics.deferred !== metrics.reviewedItems) errors.push(`${label} 审核结论数量与 reviewedItems 不闭合`);
  if ((run.reviews || []).length !== metrics.reviewedItems) errors.push(`${label}.reviews 数量与 reviewedItems 不一致`);

  const strictCoverage = Number(run.policyVersion || 0) >= 2;
  const batchScreening = Number(run.policyVersion || 0) >= 3;
  if (!strictCoverage && run.coverageStatus !== "legacy-incomplete") errors.push(`${label} 旧版不完整运行必须显式标记 legacy-incomplete`);
  if (strictCoverage && (run.sourceChecks || []).length !== metrics.officialSystemsChecked) errors.push(`${label}.sourceChecks 必须逐一记录全部检查来源`);
  const checkedSourceIds = new Set();
  for (const [sourceIndex, check] of (run.sourceChecks || []).entries()) {
    const checkLabel = `${label}.sourceChecks[${sourceIndex}]`;
    const source = sources.get(check.sourceId);
    if (!source) errors.push(`${checkLabel} 未引用已登记信息源`);
    if (!check.status || !check.note) errors.push(`${checkLabel} 状态或说明缺失`);
    if (!sourceCheckStatuses.has(check.status)) errors.push(`${checkLabel}.status 不受支持`);
    if (checkedSourceIds.has(check.sourceId)) errors.push(`${checkLabel}.sourceId 重复`);
    checkedSourceIds.add(check.sourceId);
    if (strictCoverage) {
      if (!Number.isInteger(check.attempts) || check.attempts < 1) errors.push(`${checkLabel}.attempts 必须是正整数`);
      if (!minuteTimestamp.test(check.checkedAt || "")) errors.push(`${checkLabel}.checkedAt 必须精确到北京时间分钟`);
      const failed = ["failed", "temporarily-unavailable", "semantic-404"].includes(check.status);
      if (failed && ["critical", "active"].includes(source?.tier) && check.attempts < 3) errors.push(`${checkLabel} 关键来源失败前必须至少尝试 3 次`);
    }
    if (Number(run.policyVersion || 0) >= 7) {
      const collectionMetrics = check.collectionMetrics;
      const metricLabel = `${checkLabel}.collectionMetrics`;
      if (!collectionMetrics || !["completed", "partial", "not-completed", "unavailable"].includes(collectionMetrics.state)) {
        errors.push(`${metricLabel}.state 必须明确说明本轮采集是否完成、部分完成或不可用`);
      } else {
        if (!("collected" in collectionMetrics) || !("afterFilter" in collectionMetrics) || !collectionMetrics.filterDescription) {
          errors.push(`${metricLabel} 必须记录采集数、筛选后数量和筛选说明`);
        }
        if (["completed", "partial"].includes(collectionMetrics.state)) {
          if (!Number.isInteger(collectionMetrics.collected) || collectionMetrics.collected < 0) errors.push(`${metricLabel}.collected 必须是非负整数`);
          if (!Number.isInteger(collectionMetrics.afterFilter) || collectionMetrics.afterFilter < 0) errors.push(`${metricLabel}.afterFilter 必须是非负整数`);
          if (Number.isInteger(collectionMetrics.collected) && Number.isInteger(collectionMetrics.afterFilter) && collectionMetrics.afterFilter > collectionMetrics.collected) errors.push(`${metricLabel} 筛选后数量不能大于采集数量`);
        } else if (collectionMetrics.collected !== null || collectionMetrics.afterFilter !== null) {
          errors.push(`${metricLabel} 未完成或不可用时必须用 null，不能伪装为 0 条`);
        }
      }
    }
  }
  const isTargetedRemediation = run.scope === "targeted-remediation";
  if (Number(run.policyVersion || 0) >= 5 && !isTargetedRemediation && run.coverageStatus === "aggregate-first-collection-and-source-health") {
    const expectedSourceIds = Array.isArray(run.scheduledSourceIds) ? new Set(run.scheduledSourceIds) : runIndex === 0 ? new Set([...everyRunOfficial, ...everyRunDiscovery]) : undefined;
    if (expectedSourceIds) {
      for (const sourceId of expectedSourceIds) if (!checkedSourceIds.has(sourceId)) errors.push(`${label}.sourceChecks 缺少该轮已登记来源：${sourceId}`);
      if (checkedSourceIds.size !== expectedSourceIds.size) errors.push(`${label}.sourceChecks 必须恰好覆盖该轮登记的官方与发现来源`);
    }
  }
  if (Number(run.policyVersion || 0) >= 4) {
    const incompleteSources = (run.sourceChecks || []).filter((check) => incompleteSourceStatuses.has(check.status)).length;
    if (metrics.officialSystemsFailed !== incompleteSources) errors.push(`${label} 未完成来源数量必须与 sourceChecks 状态闭合`);
  }
  if (strictCoverage && metrics.officialSystemsFailed > 0 && run.status !== "completed-partial") errors.push(`${label} 有来源失败时必须标记 completed-partial`);
  if (batchScreening) {
    const nativeFilterStrategy = Number(run.screeningStrategyVersion || 1) >= 2;
    const screeningMetricKeys = nativeFilterStrategy ? nativeFilterMetricKeys : legacyScreeningMetricKeys;
    for (const key of screeningMetricKeys) {
      if (!Number.isInteger(run.screeningMetrics?.[key]) || run.screeningMetrics[key] < 0) errors.push(`${label}.screeningMetrics.${key} 必须是非负整数`);
    }
    if (nativeFilterStrategy && (run.screeningMetrics?.nativeFilteredResults || 0) > (run.screeningMetrics?.portalResultsReported || 0)) errors.push(`${label} 站内筛选结果不能大于入口报告总量`);
    if (nativeFilterStrategy && (run.screeningMetrics?.deduplicatedCandidates || 0) > (run.screeningMetrics?.nativeFilteredResults || 0)) errors.push(`${label} 去重候选不能大于站内筛选结果`);
    if ((run.screeningMetrics?.positionsEscalated || 0) > 20) errors.push(`${label} 高推理升级数超过每轮 20 项上限`);
  }
  if (Number(run.candidateProcessingVersion || 0) >= 1) {
    const telecomChecked = (run.sourceChecks || []).some((check) => check.sourceId === "chinatelecom-careers" && check.status === "checked-full-pagination");
    const candidates = run.screeningMetrics?.deduplicatedCandidates || 0;
    const telecomReviews = (run.reviews || []).filter((review) => review.sourceId === "chinatelecom-careers").length;
    if (telecomChecked && telecomReviews !== candidates) errors.push(`${label} 中国电信已采集候选必须逐项写入审核记录`);
    if (telecomChecked && (run.screeningMetrics?.positionsBatchReviewed || 0) !== candidates) errors.push(`${label} 中国电信候选必须全部完成批量审核`);
  }
  if (Number(run.candidateProcessingVersion || 0) >= 2) {
    const telecomReviews = (run.reviews || []).filter((review) => review.sourceId === "chinatelecom-careers");
    for (const [reviewIndex, review] of telecomReviews.entries()) if (!review.semanticBasis) errors.push(`${label} 中国电信语义审核记录 ${reviewIndex} 缺少基于官网字段的判断依据`);
    const telecomChecked = (run.sourceChecks || []).some((check) => check.sourceId === "chinatelecom-careers" && check.status === "checked-full-pagination");
    if (runIndex === 0 && telecomChecked) {
      const acceptedUrls = new Set(telecomReviews.filter((review) => review.decision === "accepted").map((review) => review.officialUrl));
      const publishedUrls = new Set((opportunities.jobs || []).filter((job) => job.sourceId === "chinatelecom-careers").map((job) => job.officialApplyUrl));
      for (const url of acceptedUrls) if (!publishedUrls.has(url)) errors.push(`${label} 已接受的中国电信岗位没有写入正文：${url}`);
      for (const url of publishedUrls) if (!acceptedUrls.has(url)) errors.push(`${label} 正文中的中国电信岗位没有本轮接受结论：${url}`);
    }
  }
  if (run.status === "completed-partial" && opportunities.meta?.lastRunStatus !== "completed-partial" && runIndex === 0) errors.push("最新运行部分完成时，正文 meta.lastRunStatus 必须同步");
  if (runIndex === 0) {
    if (opportunities.meta?.lastIncompleteSourceCount !== metrics.officialSystemsFailed) errors.push("正文 meta.lastIncompleteSourceCount 必须与最新运行一致");
    if (opportunities.meta?.lastDeferredCandidateCount !== (run.screeningMetrics?.positionsDeferredByBudget || 0)) errors.push("正文 meta.lastDeferredCandidateCount 必须与最新运行一致");
  }

  for (const [reviewIndex, review] of (run.reviews || []).entries()) {
    const reviewLabel = `${label}.reviews[${reviewIndex}]`;
    for (const key of ["id", "scope", "track", "organization", "title", "officialPublishedAt", "headcount", "deadline", "decision", "reasonCode", "reason", "verificationNote", "fallback", "sourceId", "officialUrl"]) {
      if (!review[key]) errors.push(`${reviewLabel}.${key} 缺失`);
    }
    const runScopedReviewId = `${run.id}:${review.id}`;
    if (reviewIds.has(runScopedReviewId)) errors.push(`${reviewLabel}.id 在同一轮中重复`);
    reviewIds.add(runScopedReviewId);
    if (!decisions.has(review.decision)) errors.push(`${reviewLabel}.decision 不受支持`);
    const source = sources.get(review.sourceId);
    if (!source?.officialSiteConfirmed) errors.push(`${reviewLabel}.sourceId 未登记为官方来源`);
    else if (!officialDomain(review.officialUrl, source)) errors.push(`${reviewLabel}.officialUrl 不属于登记的官方域名`);
  }
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}
console.log(`审核日志门禁通过：${log.runs.length} 轮运行，${reviewIds.size} 个匿名审核对象。`);
