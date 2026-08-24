import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const registry = JSON.parse(await readFile(new URL("data/source-registry.json", root), "utf8"));
const plan = JSON.parse(await readFile(new URL("data/source-plan.json", root), "utf8"));
const errors = [];
const sourceIds = new Set();

function validSourceUrl(value, source) {
  try {
    const url = new URL(value);
    const officialHost = source.domains.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
    const permittedHttp = ["official-http-only", "official-http-fallback"].includes(source.transportSecurity) && url.protocol === "http:";
    return officialHost && (url.protocol === "https:" || permittedHttp);
  } catch { return false; }
}

if (registry.version !== 4) errors.push("source-registry.version 必须为 4");
if (plan.version !== 4) errors.push("source-plan.version 必须为 4");
if (plan.timezone !== "Asia/Shanghai") errors.push("source-plan.timezone 必须为 Asia/Shanghai");

for (const [index, source] of (registry.sources || []).entries()) {
  for (const key of ["id", "organization", "type", "role", "tier", "cadence", "domains", "entryUrl"]) {
    if (!source[key] || (Array.isArray(source[key]) && !source[key].length)) errors.push(`sources[${index}].${key} 缺失`);
  }
  if (sourceIds.has(source.id)) errors.push(`来源 id 重复：${source.id}`);
  sourceIds.add(source.id);
  if (!validSourceUrl(source.entryUrl, source)) errors.push(`来源 URL 无效、域名不匹配或未获 HTTP 例外：${source.id}`);
  for (const alternate of (source.alternateEntryUrls || [])) {
    if (!validSourceUrl(alternate, source)) errors.push(`备用来源 URL 无效、域名不匹配或未获 HTTP 例外：${source.id}`);
  }
  if (source.transportSecurity?.startsWith("official-http-") && !/^\d{4}-\d{2}-\d{2}$/.test(source.httpOnlyVerifiedAt || "")) errors.push(`允许 HTTP 的官方来源缺少核验日期：${source.id}`);
  if (source.recipeRequired && (!source.accessMode || !/^\d{4}-\d{2}-\d{2}$/.test(source.lastAccessAuditAt || ""))) errors.push(`需要筛选配方的来源缺少访问方式或核验日期：${source.id}`);
  if (source.accessMode === "semantic-health-check-required" && !source.semanticFailureSignals?.length) errors.push(`语义健康检查来源缺少失败信号：${source.id}`);
  if (source.role === "authoritative" && source.officialSiteConfirmed !== true) errors.push(`权威来源未确认官方属性：${source.id}`);
  if (source.role === "discovery" && source.officialSiteConfirmed !== false) errors.push(`发现来源不得标记为官方证据：${source.id}`);
}

for (const source of registry.sources || []) {
  if (source.coverage?.includes("选调优培") && !source.id.endsWith("-selection-program") && source.id !== "buaa-career-discovery") {
    errors.push(`选调优培标签只能指向实际选调采集来源或北航就业网发现入口：${source.id}`);
  }
}

const retry = plan.retryPolicy || {};
if (retry.criticalMaxAttempts < 3 || retry.activeMaxAttempts < 3) errors.push("critical 与 active 来源必须至少尝试 3 次");
if (retry.failureOutcome !== "completed-partial") errors.push("来源失败的运行结果必须是 completed-partial");
if (retry.semanticHealthCheckRequired !== true) errors.push("来源访问必须检查最终地址和页面语义，不能只看 HTTP 状态码");
const requestPolicy = plan.requestPolicy || {};
if (requestPolicy.maxConcurrentPerHost !== 1) errors.push("公开采集必须限制为同域名单并发");
if (!Number.isInteger(requestPolicy.minHostIntervalMs) || requestPolicy.minHostIntervalMs < 500) errors.push("同域名请求间隔不得低于 500ms");
if (!Array.isArray(requestPolicy.backoffMs) || requestPolicy.backoffMs.length < 3) errors.push("请求重试必须配置至少三档退避");
if (requestPolicy.honorRetryAfter !== true) errors.push("请求重试必须遵守 Retry-After");
if (!Number.isInteger(requestPolicy.circuitCooldownMs) || requestPolicy.circuitCooldownMs < 60_000) errors.push("反爬熔断冷却不得低于 60 秒");
for (const status of [408, 429, 500, 502, 503, 504]) {
  if (!requestPolicy.retryableStatuses?.includes(status)) errors.push(`缺少可重试 HTTP 状态：${status}`);
}
if (requestPolicy.accessControlOutcome !== "accessible-incomplete") errors.push("访问控制触发后必须降级为 accessible-incomplete");
for (const status of ["checked-native-filtered", "checked-no-active-campaign", "checked-browser-route", "accessible-incomplete", "temporarily-unavailable", "semantic-404"]) {
  if (!plan.sourceOutcomeDefinitions?.[status]) errors.push(`缺少来源结果定义：${status}`);
}
if (!Array.isArray(plan.fallbackOrder) || plan.fallbackOrder.length < 4) errors.push("官方入口 fallback 顺序不完整");

const listed = [
  ...(plan.coverage?.criticalEveryRun || []),
  ...(plan.coverage?.everyRunOfficial || []),
  ...(plan.coverage?.everyRunDiscovery || []),
];
for (const id of listed) if (!sourceIds.has(id)) errors.push(`source-plan 引用了未登记来源：${id}`);
for (const id of (plan.coverage?.criticalEveryRun || [])) {
  const source = registry.sources.find((item) => item.id === id);
  if (source?.tier !== "critical" || source?.cadence !== "every-run") errors.push(`关键来源分级或频次错误：${id}`);
}
const everyRunOfficial = new Set(plan.coverage?.everyRunOfficial || []);
const everyRunDiscovery = new Set(plan.coverage?.everyRunDiscovery || []);
for (const source of registry.sources || []) {
  if (source.officialSiteConfirmed && source.monitoringEnabled !== false) {
    if (!everyRunOfficial.has(source.id)) errors.push(`每轮全量官方来源缺失：${source.id}`);
    if (source.cadence !== "every-run") errors.push(`全量官方来源频次必须为 every-run：${source.id}`);
  }
  if (source.role === "discovery" && !everyRunDiscovery.has(source.id)) errors.push(`每轮全量发现来源缺失：${source.id}`);
}
if (everyRunOfficial.size !== (registry.sources || []).filter((source) => source.officialSiteConfirmed && source.monitoringEnabled !== false).length) errors.push("everyRunOfficial 必须恰好覆盖全部启用监测的官方来源");
if (everyRunDiscovery.size !== (registry.sources || []).filter((source) => source.role === "discovery").length) errors.push("everyRunDiscovery 必须恰好覆盖全部发现来源");

if (!plan.announcementLifecycle?.beforeApplicationOpens?.includes("不得")) errors.push("必须明确预公告不得因尚未开放报名而排除");
if (!plan.announcementLifecycle?.withPositionTable?.includes("具体岗位")) errors.push("预公告附职位表时必须拆到具体岗位");
if (plan.qualityFilter?.unknownIsNotNegative !== true) errors.push("薪资或强度未知不得作为负面事实");
if (plan.qualityFilter?.lowRankNeverMeansExclude !== true) errors.push("低排名不得自动排除岗位");
if (!plan.positionScan?.largeDatasetStrategy?.includes("screening-policy.json") || !plan.positionScan.largeDatasetStrategy.includes("filter-recipes.json")) errors.push("大规模职位入口必须引用 screening-policy.json 与 filter-recipes.json");
const relevanceGate = plan.profileRelevanceGate || {};
if (!Array.isArray(relevanceGate.discoveryOnlyTerms) || !relevanceGate.discoveryOnlyTerms.includes("人工智能")) errors.push("必须把人工智能等词限定为发现词");
if (!/是否可报以官方专业、学历和招录对象要求为主/.test(relevanceGate.rule || "")) errors.push("来源计划必须把专业资格作为收录主门禁");
if (!/纯计算机岗位还必须具有明确生物医学交叉场景/.test(relevanceGate.publicDisplayRule || "")) errors.push("纯计算机岗位必须有生物医学交叉场景");
if (!/若无明确生物医学交叉场景则排除/.test(relevanceGate.rule || "")) errors.push("来源计划必须排除无生物医学交叉的纯计算机岗位");

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}
console.log(`来源计划门禁通过：${registry.sources.length} 个来源，每轮全量检查 ${plan.coverage.everyRunOfficial.length} 个官方来源和 ${plan.coverage.everyRunDiscovery.length} 个发现来源。`);
