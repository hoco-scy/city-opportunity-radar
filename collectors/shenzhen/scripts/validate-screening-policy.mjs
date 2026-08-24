import { access, readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const policy = JSON.parse(await readFile(new URL("data/screening-policy.json", root), "utf8"));
const recipes = JSON.parse(await readFile(new URL("data/filter-recipes.json", root), "utf8"));
const registry = JSON.parse(await readFile(new URL("data/source-registry.json", root), "utf8"));
const errors = [];
const sources = new Map(registry.sources.map((source) => [source.id, source]));

if (policy.version !== 3) errors.push("screening-policy.version 必须为 3");
if (policy.mode !== "official-native-filter-first") errors.push("筛选模式必须是 official-native-filter-first");

for (const key of ["preferOfficialNativeFilters", "neverTraverseUnfilteredPortalWhenReliableFiltersExist", "combineQueriesByUnion", "deduplicateBeforeModelReview", "lowRankNeverMeansExclude", "unknownMeansDeferNotReject"]) {
  if (policy.principles?.[key] !== true) errors.push(`principles.${key} 必须为 true`);
}
for (const key of ["httpStatusAloneNeverMeansSuccess", "accessibleIncompleteIsNotUnavailable"]) {
  if (policy.principles?.[key] !== true) errors.push(`principles.${key} 必须为 true`);
}

const stageIds = new Set((policy.stages || []).map((stage) => stage.id));
for (const id of ["discover-native-capabilities", "native-filter-union", "normalize-and-deduplicate", "semantic-batch-review", "official-verification"]) {
  if (!stageIds.has(id)) errors.push(`缺少筛选阶段：${id}`);
}

if (policy.sourceCapabilityPolicy?.registry !== "data/filter-recipes.json") errors.push("必须使用 filter-recipes.json 保存站点筛选能力");
if (policy.sourceCapabilityPolicy?.stopNarrowingWhenAtOrBelow > 100) errors.push("安全筛选后不超过 100 个岗位时必须停止继续缩小");
if (policy.sourceCapabilityPolicy?.keywordFiltersOnlyWhenSafeFiltersStillExceed < 150) errors.push("结果不超过 150 个岗位时不得为节省成本强制使用关键词缩小");
if (!policy.sourceCapabilityPolicy?.semanticHealthChecks?.length) errors.push("必须登记页面语义健康检查");
if (policy.sourceCapabilityPolicy?.accessibleButIncompleteOutcome !== "accessible-incomplete") errors.push("能打开但未处理完必须记为 accessible-incomplete");

const relevanceGate = policy.profileRelevanceGate || {};
if (relevanceGate.discoveryTermsAreNotPublicationEvidence !== true) errors.push("发现词不得直接作为发布匹配依据");
if (relevanceGate.candidateFocus !== "biomedical-engineering-and-adjacent-engineering") errors.push("岗位匹配必须面向生物医学工程及交叉工程背景");
if (relevanceGate.roleTextNeverRejectsEligibleMajor !== false || relevanceGate.pureComputingRequiresBiomedicalBridge !== true) errors.push("纯计算机岗位必须有生物医学交叉场景");
if (!Array.isArray(relevanceGate.eligibilityEvidenceFields) || relevanceGate.eligibilityEvidenceFields.length < 3) errors.push("资格门禁必须登记官方专业、学历和招录对象字段");
if (!Array.isArray(relevanceGate.eligibleMajorScopes) || relevanceGate.eligibleMajorScopes.length < 4) errors.push("资格门禁缺少完整的可报专业口径");

const model = policy.modelPolicy || {};
if (model.routineModel !== "GPT-5.6 Terra") errors.push("常规任务模型必须是 GPT-5.6 Terra");
if (!Number.isInteger(model.batchSizeTarget) || model.batchSizeTarget < 20 || model.batchSizeTarget > 60) errors.push("模型批量复核目标必须在 20 至 60 个岗位之间");
if (model.highReasoning?.defaultEnabled !== false) errors.push("高推理不得默认参与常规扫描");
if (!Number.isInteger(model.highReasoning?.maxItemsPerRun) || model.highReasoning.maxItemsPerRun > 20) errors.push("高推理每轮最多处理 20 项");
if (model.highReasoning?.overflowOutcome !== "deferred") errors.push("高推理溢出项必须进入 deferred");

const requiredMetrics = new Set(policy.requiredRunMetrics || []);
for (const key of ["portalResultsReported", "nativeFilterQueries", "nativeFilteredResults", "deduplicatedCandidates", "positionsBatchReviewed", "positionsOfficiallyVerified", "positionsEscalated", "positionsDeferredByBudget"]) {
  if (!requiredMetrics.has(key)) errors.push(`缺少运行指标：${key}`);
}

if (recipes.version !== 3 || !Array.isArray(recipes.recipes)) errors.push("filter-recipes.json 必须为版本 3，且含有 recipes 数组");
if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00[+-]\d{2}:\d{2}$/.test(recipes.verifiedAt || "")) errors.push("filter-recipes.json 缺少带时区的分钟级 verifiedAt");
const recipeIds = new Set();
const recipeStatuses = new Set([
  "verified", "script-verified", "verified-no-native-filter", "route-verified", "browser-required",
  "announcement-discovery", "temporarily-unavailable", "pending-observation"
]);
const collectionMethods = new Set(["browser", "script"]);
const availabilityStates = new Set([
  "available", "available-via-official-fallback", "browser-recovery-required",
  "temporarily-unavailable", "semantic-404"
]);
for (const recipe of (recipes.recipes || [])) {
  if (!recipe.sourceId || recipeIds.has(recipe.sourceId)) errors.push(`筛选配方 sourceId 缺失或重复：${recipe.sourceId || "unknown"}`);
  recipeIds.add(recipe.sourceId);
  if (!sources.has(recipe.sourceId)) errors.push(`筛选配方引用未登记来源：${recipe.sourceId}`);
  if (!recipeStatuses.has(recipe.status)) errors.push(`筛选配方状态无效：${recipe.sourceId}`);
  if (recipe.status === "verified" && (!recipe.nativeFilters?.length || !recipe.queryPlan)) errors.push(`已验证筛选配方缺少控件或查询计划：${recipe.sourceId}`);
  if (["verified-no-native-filter", "route-verified", "browser-required", "announcement-discovery"].includes(recipe.status) && !recipe.queryPlan) errors.push(`来源处理配方缺少查询计划：${recipe.sourceId}`);
  if (recipe.status === "temporarily-unavailable" && !recipe.failureSignals?.length) errors.push(`暂不可用来源缺少语义失败信号：${recipe.sourceId}`);
  if (recipe.status !== "pending-observation" && !/^\d{4}-\d{2}-\d{2}$/.test(recipe.observedAt || "")) errors.push(`筛选配方缺少核验日期：${recipe.sourceId}`);
  if (!recipe.accessMode) errors.push(`筛选配方缺少访问方式：${recipe.sourceId}`);
  const collection = recipe.collection || {};
  if (!collectionMethods.has(collection.primary)) errors.push(`来源必须明确 browser 或 script 采集方式：${recipe.sourceId}`);
  if (typeof collection.mode !== "string" || !collection.mode) errors.push(`来源缺少具体采集模式：${recipe.sourceId}`);
  if (!Array.isArray(collection.steps) || collection.steps.length < 3) errors.push(`来源缺少可执行的采集步骤：${recipe.sourceId}`);
  if (typeof collection.completion !== "string" || !collection.completion) errors.push(`来源缺少完成判定：${recipe.sourceId}`);
  if (collection.primary === "script") {
    const announcementCollector = /(?:announcement|topic|workbook)/i.test(collection.mode);
    if (!announcementCollector && (!Array.isArray(collection.nativeFilters) || collection.nativeFilters.length < 3)) errors.push(`脚本来源缺少原生筛选组合：${recipe.sourceId}`);
    if (!announcementCollector && (typeof collection.pagination !== "string" || !collection.pagination)) errors.push(`脚本来源缺少筛选后分页规则：${recipe.sourceId}`);
    if (!announcementCollector && (!Array.isArray(collection.deduplicateBy) || !collection.deduplicateBy.length)) errors.push(`脚本来源缺少去重规则：${recipe.sourceId}`);
    const implementation = collection.implementation || {};
    const commandMatch = typeof implementation.command === "string" && implementation.command.match(/^node\s+(scripts\/[A-Za-z0-9._-]+\.mjs)(?:\s|$)/);
    if (!commandMatch || !implementation.smokeTest || !implementation.runtime || !implementation.hardGuard) {
      errors.push(`脚本来源缺少可执行命令、冒烟测试、无状态运行说明或未筛选全集保护：${recipe.sourceId}`);
    } else {
      try { await access(new URL(commandMatch[1], root)); }
      catch { errors.push(`脚本来源的采集程序不存在：${recipe.sourceId} → ${commandMatch[1]}`); }
    }
  }
  const availability = recipe.availability || {};
  if (!availabilityStates.has(availability.state)) errors.push(`来源缺少有效的可用性结论：${recipe.sourceId}`);
  if (!Array.isArray(availability.evidence) || !availability.evidence.length) errors.push(`来源缺少本轮可用性证据：${recipe.sourceId}`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00[+-]\d{2}:\d{2}$/.test(availability.evidence?.[0]?.checkedAt || "")) errors.push(`来源可用性证据缺少分钟级时间：${recipe.sourceId}`);
  if (availability.state === "temporarily-unavailable" && recipe.status !== "temporarily-unavailable") errors.push(`不可用状态未同步到来源状态：${recipe.sourceId}`);
  if (availability.state === "semantic-404" && recipe.status !== "temporarily-unavailable") errors.push(`语义 404 必须进入暂不可用来源状态：${recipe.sourceId}`);
}
for (const source of registry.sources) {
  if (!recipeIds.has(source.id)) errors.push(`所有登记来源都必须有采集配方：${source.id}`);
}
for (const id of ["national-civil", "central-enterprise-roster", "china-public-recruitment", "central-sasac-recruitment", "picc-campus", "sinopec-careers"]) {
  const recipe = recipes.recipes.find((item) => item.sourceId === id);
  if (!recipe?.availabilityRule) errors.push(`${id} 缺少入口可用性判定规则`);
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}
console.log(`站内筛选策略门禁通过：${recipes.recipes.length} 个来源已有筛选配方记录，常规批量 ${model.batchSizeTarget} 项。`);
