import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const data = JSON.parse(await readFile(new URL("data/opportunities.json", root), "utf8"));
const registry = JSON.parse(await readFile(new URL("data/source-registry.json", root), "utf8"));
const sources = new Map(registry.sources.map((source) => [source.id, source]));
const errors = [];
const required = [
  "id", "track", "organization", "department", "title", "exactTitle", "jobCode",
  "location", "cohort", "education", "majors", "responsibilities", "requirements",
  "publishedAt", "deadline", "status", "matchLevel", "matchReason", "sourceId",
  "officialAnnouncementUrl", "officialApplyUrl", "verifiedAt", "lastSeenAt",
  "lastSeenStatus", "statusEvidence", "verifiedFields", "verification"
];
const publicExamTracks = new Set(["考公", "选调优培"]);
const publicExamChecks = [
  "graduationAndDegree", "candidateCategory", "majorAndCode", "ageAndNationality",
  "householdOrStudentOrigin", "institutionAndStudyMode", "politicalStatus",
  "grassrootsExperience", "honorsAndRecommendation", "certificatesAndOtherLimits",
  "avoidanceRules", "positionNotes"
];
const minuteTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/;
const runStatuses = new Set(["completed", "completed-partial", "failed", "not-started"]);
const lastSeenStatuses = new Set(["live", "upcoming", "temporarily-unavailable", "closed"]);
const jobStatuses = new Set(["招聘中", "即将开放", "临时无法复查", "已关闭"]);

function officialDomain(urlValue, source) {
  try {
    const url = new URL(urlValue);
    const permittedProtocol = url.protocol === "https:" || (["official-http-only", "official-http-fallback"].includes(source.transportSecurity) && url.protocol === "http:");
    return permittedProtocol && source.domains.some((domain) =>
      url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch { return false; }
}

const awaitingFirstSync = data.meta?.initializationStatus === "awaiting-first-sync";
if (data.meta?.schemaVersion !== 1) errors.push("meta.schemaVersion 必须为 1");
if (awaitingFirstSync) {
  if (data.meta?.lastVerifiedAt !== null) errors.push("首次同步前 lastVerifiedAt 必须为 null");
  if (data.meta?.lastRunStatus !== "not-started") errors.push("首次同步前 lastRunStatus 必须为 not-started");
} else {
  if (!minuteTimestamp.test(data.meta?.lastVerifiedAt || "")) errors.push("meta.lastVerifiedAt 必须是精确到分钟的北京时间，例如 2026-08-22T08:03:00+08:00");
  if (!runStatuses.has(data.meta?.lastRunStatus) || data.meta?.lastRunStatus === "not-started") errors.push("meta.lastRunStatus 必须是 completed、completed-partial 或 failed");
}
if (!Number.isInteger(data.meta?.lastIncompleteSourceCount) || data.meta.lastIncompleteSourceCount < 0) errors.push("meta.lastIncompleteSourceCount 必须是非负整数");
if (!Number.isInteger(data.meta?.lastDeferredCandidateCount) || data.meta.lastDeferredCandidateCount < 0) errors.push("meta.lastDeferredCandidateCount 必须是非负整数");
if (!Array.isArray(data.jobs) || !Array.isArray(data.monitors) || !Array.isArray(data.candidates ?? [])) errors.push("jobs、monitors 和 candidates 必须是数组");

const ids = new Set();
for (const [index, job] of (data.jobs || []).entries()) {
  const label = `jobs[${index}]`;
  for (const key of required) {
    const value = job[key];
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)) errors.push(`${label}.${key} 缺失`);
  }
  if (ids.has(job.id)) errors.push(`${label}.id 重复: ${job.id}`);
  ids.add(job.id);
  if (!minuteTimestamp.test(job.lastSeenAt || "")) errors.push(`${label}.lastSeenAt 必须精确到北京时间分钟`);
  if (!lastSeenStatuses.has(job.lastSeenStatus)) errors.push(`${label}.lastSeenStatus 不受支持`);
  if (!jobStatuses.has(job.status)) errors.push(`${label}.status 不受支持`);
  if (job.status === "招聘中" && job.lastSeenStatus !== "live") errors.push(`${label} 标记招聘中但最近复查不是 live`);
  if (job.status === "即将开放" && job.lastSeenStatus !== "upcoming") errors.push(`${label} 标记即将开放但最近复查不是 upcoming`);

  const source = sources.get(job.sourceId);
  if (!source?.officialSiteConfirmed) errors.push(`${label}.sourceId 未登记为官方来源`);
  else {
    if (!officialDomain(job.officialAnnouncementUrl, source)) errors.push(`${label}.officialAnnouncementUrl 不属于登记的官方域名`);
    if (!officialDomain(job.officialApplyUrl, source)) errors.push(`${label}.officialApplyUrl 不属于登记的官方域名`);
  }

  for (const field of ["officialSource", "specificPosition", "location", "eligibility", "applicationPath", "deadlineChecked"]) {
    if (job.verification?.[field] !== true) errors.push(`${label}.verification.${field} 未通过`);
  }

  if (publicExamTracks.has(job.track)) {
    if (job.eligibilityDecision !== "confirmed") errors.push(`${label} 是公考/选调岗位，但 eligibilityDecision 不是 confirmed`);
    const checks = new Map((job.eligibilityChecks || []).map((check) => [check.key, check.status]));
    for (const key of publicExamChecks) {
      if (checks.get(key) !== "pass") errors.push(`${label} 公考资格检查 ${key} 未明确通过`);
    }
    if (job.riskNotes?.length) errors.push(`${label} 公考岗位仍有未决风险，不允许发布`);
  }
}

for (const [index, candidate] of (data.candidates || []).entries()) {
  const label = `candidates[${index}]`;
  for (const key of ["id", "track", "organization", "title", "location", "education", "majors", "publishedAt", "deadline", "status", "matchLevel", "matchReason", "sourceId", "sourceUrl", "verifiedAt", "manualConfirmationRequired", "manualConfirmationReason", "backtracking"]) {
    if (candidate[key] === undefined || candidate[key] === null || candidate[key] === "") errors.push(`${label}.${key} 缺失`);
  }
  if (ids.has(candidate.id)) errors.push(`${label}.id 与其他公开记录重复: ${candidate.id}`);
  ids.add(candidate.id);
  if (candidate.track !== "待确认线索") errors.push(`${label}.track 必须是待确认线索`);
  if (candidate.status !== "待用户确认") errors.push(`${label}.status 必须是待用户确认`);
  if (candidate.manualConfirmationRequired !== true) errors.push(`${label}.manualConfirmationRequired 必须为 true`);
  if (!minuteTimestamp.test(candidate.verifiedAt || "")) errors.push(`${label}.verifiedAt 必须精确到北京时间分钟`);
  const source = sources.get(candidate.sourceId);
  if (!source || source.role !== "discovery") errors.push(`${label}.sourceId 未登记为发现来源`);
  else if (!officialDomain(candidate.sourceUrl, source)) errors.push(`${label}.sourceUrl 不属于登记的平台来源域名`);
}

for (const [index, monitor] of (data.monitors || []).entries()) {
  for (const key of ["id", "track", "title", "status", "note", "officialUrl", "checkedAt"]) {
    if (!monitor[key]) errors.push(`monitors[${index}].${key} 缺失`);
  }
  if (!minuteTimestamp.test(monitor.checkedAt || "")) errors.push(`monitors[${index}].checkedAt 必须精确到北京时间分钟`);
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}
console.log(`数据门禁通过：${data.jobs.length} 个具体岗位，${(data.candidates || []).length} 条待用户确认线索，${data.monitors.length} 个公告监测项。`);
