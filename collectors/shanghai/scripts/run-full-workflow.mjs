#!/usr/bin/env node
/**
 * Full city sync. Aggregate platforms are the discovery front door; a
 * discovery record can never publish a job until its employer/government
 * source has been verified separately.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { buildPublicExamRun } from "./run-public-exam-sync.mjs";
import { collectBuaaDiscovery } from "./collect-buaa-discovery.mjs";
import { collectIGuopinDiscovery } from "./collect-iguopin-discovery.mjs";
import { collectNCSSDiscovery } from "./collect-ncss-discovery.mjs";
import { collectPiccCampus } from "./collect-picc-campus.mjs";
import { collectBoeCampus } from "./collect-boe-campus.mjs";
import { collectCrcCareers } from "./collect-crc-careers.mjs";
import { collectOfficialNoticeFeed } from "./collect-official-notice-feed.mjs";
import { createCollectionFetch } from "./resilient-fetch.mjs";
import { mergeDiscoveryCandidates, mergeOfficialMonitors } from "./collection-merge.mjs";

const root = new URL("../", import.meta.url);
const args = new Set(process.argv.slice(2));
if (!args.has("--full-update")) throw new Error("请使用 --full-update 执行完整采集；不能用入口探测冒充完整更新。");

function shanghaiMinute() {
  const parts = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date()).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00+08:00`;
}

async function readJson(path) { return JSON.parse(await readFile(new URL(path, root), "utf8")); }

async function probeOfficialEntry(source, checkedAt) {
  const urls = [source.collectionEntryUrl || source.entryUrl, ...(source.alternateEntryUrls || [])];
  const attempts = Math.max(["critical", "active"].includes(source.tier) ? 3 : 1, urls.length);
  const accessEvidence = [];
  let usable = false;
  let semantic404 = false;
  for (let index = 0; index < attempts && !usable; index += 1) {
    const requestedUrl = urls[index % urls.length];
    try {
      const response = await fetch(requestedUrl, { redirect: "follow", signal: AbortSignal.timeout(12_000), headers: { "user-agent": "Mozilla/5.0" } });
      const body = (await response.text()).slice(0, 12_000);
      const isSemantic404 = /(?:页面不存在|not found|error 404|访问出错)/i.test(body) || /(?:\/404|\/error)(?:[/?#]|$)/i.test(response.url);
      if (response.ok && !isSemantic404) {
        usable = true;
        accessEvidence.push({ requestedUrl, finalUrl: response.url, outcome: "page-incomplete", recipe: "公开入口可打开；尚未完成本站筛选、分页、附件和逐岗核验。" });
      } else if (isSemantic404) {
        semantic404 = true;
        accessEvidence.push({ requestedUrl, outcome: "semantic-404", recipe: "公开入口返回明确的不存在或错误页。" });
      } else accessEvidence.push({ requestedUrl, outcome: "network-error", recipe: `公开入口返回 HTTP ${response.status}。` });
    } catch (error) {
      accessEvidence.push({ requestedUrl, outcome: "network-error", recipe: `公开入口本轮无法连接：${error?.name || "fetch-error"}。` });
    }
  }
  if (usable) return {
    sourceId: source.id, status: "accessible-incomplete", attempts: accessEvidence.length, checkedAt,
    note: "入口可访问，但本轮尚未在该来源完成原生筛选、分页、附件与逐岗核验；不据此发布岗位。",
    collectionMetrics: {
      state: "not-completed", collected: null, afterFilter: null,
      filterDescription: "本轮只确认官方入口可访问；本站筛选、分页、附件和逐岗核验没有完整跑通，不能把结果理解为 0 条。"
    },
    accessEvidence
  };
  if (semantic404) return {
    sourceId: source.id, status: "semantic-404", attempts: accessEvidence.length, checkedAt,
    note: "已按登记入口与备用入口重试，未取得可用页面；不据此判断无岗位。",
    collectionMetrics: {
      state: "unavailable", collected: null, afterFilter: null,
      filterDescription: "本轮没有取得可用的官方采集页面，未生成可比较的候选数量。"
    },
    accessEvidence
  };
  return {
    sourceId: source.id, status: "temporarily-unavailable", attempts: accessEvidence.length, checkedAt,
    note: "已按登记入口与备用入口重试，公开页面本轮仍不可用；不据此判断无岗位。",
    collectionMetrics: {
      state: "unavailable", collected: null, afterFilter: null,
      filterDescription: "本轮无法连接官方采集页面，未生成可比较的候选数量。"
    },
    accessEvidence
  };
}

function officialNoticeSourceCheck(result, checkedAt) {
  const complete = Number.isInteger(result.collected) && Number.isInteger(result.afterFilter);
  return {
    sourceId: result.sourceId,
    status: result.status,
    attempts: result.attempts || 1,
    checkedAt,
    note: result.reason,
    collectionMetrics: complete
      ? { state: "completed", collected: result.collected, afterFilter: result.afterFilter, filterDescription: "已从登记官方公告/招聘页提取同域招聘链接并读取公开正文；仅有公告而没有具体岗位字段时不会发布为岗位。" }
      : { state: result.status === "temporarily-unavailable" || result.status === "semantic-404" ? "unavailable" : "not-completed", collected: null, afterFilter: null, filterDescription: "本轮未能完成该官方来源的公告列表、详情或站内筛选，不能把结果理解为 0 条。" },
    accessEvidence: result.accessEvidence
  };
}

function discoverySourceCheck(source, result, checkedAt) {
  if (result.collectionError) {
    const accessControlled = result.collectionCircuitReason === "blocked";
    return {
      sourceId: source.id, status: accessControlled ? "accessible-incomplete" : "temporarily-unavailable", attempts: 1, checkedAt,
      note: accessControlled ? "该聚合平台触发访问控制，本轮已停止继续请求并保留上次结果；不尝试绕过，也不据此判断无岗位。" : "该聚合平台的公开采集接口本轮没有完成；其他来源仍继续更新，不据此判断无岗位。",
      collectionMetrics: {
        state: accessControlled ? "not-completed" : "unavailable", collected: null, afterFilter: null,
        filterDescription: "本轮无法完成该平台的公开筛选接口调用，未生成可比较的候选数量。"
      },
      accessEvidence: [{ requestedUrl: source.collectionEntryUrl || source.entryUrl, outcome: accessControlled ? "access-control" : "network-error", recipe: result.collectionError }]
    };
  }
  const candidates = result.detailOutcomes?.candidate || 0;
  const excluded = Math.max(0, result.deduplicatedCandidates - candidates);
  const paginationNote = result.truncated ? `公开访问在已读取分页后受限：${result.partialReason || "筛选结果超过本轮安全分页上限"}；未把未读取部分当作无岗位。` : "已读取本轮全部已筛选分页。";
  return {
    sourceId: source.id, status: result.truncated ? "accessible-incomplete" : "checked-native-filtered", attempts: 1, checkedAt,
    note: `已完成 ${result.nativeFilterQueries} 组本站筛选并读取 ${result.deduplicatedCandidates} 条去重候选。${candidates} 条通过应届硕士与专业相关性的初筛，进入官方回溯；${excluded} 条未进入回溯。${paginationNote}`,
    collectionMetrics: {
      state: result.truncated ? "partial" : "completed", collected: result.deduplicatedCandidates, afterFilter: candidates,
      filterDescription: result.truncated ? "已记录公开可读取分页的采集和筛选数量；后续分页要求登录或未能公开读取，不能把本轮结果理解为完整平台全集。" : "已使用本站城市、单位性质/关键词、应届硕士和生物医学相关性等条件完成预筛。"
    },
    accessEvidence: [{ requestedUrl: source.entryUrl, finalUrl: result.pagesVisited[0], outcome: "official-page", recipe: result.collectionRoute }]
  };
}

function unavailableDiscoveryResult(sourceId, error) {
  return {
    sourceId, collectionError: error?.message || "公开采集接口未返回可用结果。", leads: [], pagesVisited: [],
    collectionErrorKind: error?.kind || null, collectionCircuitReason: error?.circuitReason || null,
    portalResultsReported: 0, nativeFilterQueries: 0, nativeFilteredResults: 0, deduplicatedCandidates: 0,
    detailsChecked: 0, detailOutcomes: {}, truncated: false
  };
}

function unavailableStructuredResult(sourceId, error) {
  return { sourceId, collectionError: error?.message || `${sourceId} 官方结构化采集未完成。`, collectionErrorKind: error?.kind || null, collectionCircuitReason: error?.circuitReason || null, jobs: [] };
}

function verifiedJobsSourceCheck(source, result, checkedAt) {
  if (result.collectionError) {
    const accessControlled = result.collectionCircuitReason === "blocked";
    return {
      sourceId: source.id, status: accessControlled ? "accessible-incomplete" : "temporarily-unavailable", attempts: 3, checkedAt,
      note: accessControlled ? "该来源触发访问控制，本轮已停止继续请求并保留上次岗位；不尝试绕过访问控制。" : "本轮未能完成该来源的官方结构化采集；已发布的上次核验岗位会保留，不会被临时网络故障清空。",
      collectionMetrics: { state: accessControlled ? "not-completed" : "unavailable", collected: null, afterFilter: null, filterDescription: result.collectionError },
      accessEvidence: [{ requestedUrl: source.collectionEntryUrl || source.entryUrl, outcome: accessControlled ? "access-control" : "network-error", recipe: result.collectionError }]
    };
  }
  return {
    sourceId: source.id, status: result.status, attempts: 1, checkedAt,
    note: `已用本站公开结构化接口完成城市、招聘类型、全部分页和任职条件筛选：采集 ${result.collected} 条，专业可报 ${result.afterFilter} 条。`,
    collectionMetrics: { state: "completed", collected: result.collected, afterFilter: result.afterFilter, filterDescription: "已按官方任职条件筛选，并排除无生物医学交叉场景的纯计算机岗位。" },
    accessEvidence: result.pagesVisited.map((requestedUrl) => ({ requestedUrl, outcome: "official-structured-data", recipe: result.collectionRoute }))
  };
}

function normalizeCollectionMetrics(log, sources) {
  for (const run of log.runs || []) {
    if (Number(run.policyVersion || 0) < 7) continue;
    const reviews = run.reviews || [];
    if (run.metrics) {
      run.metrics.reviewedItems = reviews.length;
      run.metrics.accepted = reviews.filter((review) => review.decision === "accepted").length;
      run.metrics.rejected = reviews.filter((review) => review.decision === "rejected").length;
      run.metrics.deferred = reviews.filter((review) => review.decision === "deferred").length;
    }
    for (const check of run.sourceChecks || []) {
      const metrics = check.collectionMetrics;
      if (metrics && ["not-completed", "unavailable"].includes(metrics.state)) {
        metrics.collected = null;
        metrics.afterFilter = null;
      }
      if (metrics?.state === "partial" && (!Number.isInteger(metrics.collected) || !Number.isInteger(metrics.afterFilter))) {
        metrics.state = "not-completed";
        metrics.collected = null;
        metrics.afterFilter = null;
      }
      const source = sources.get(check.sourceId);
      const route = source?.collectionEntryUrl;
      if (route && ["temporarily-unavailable", "semantic-404"].includes(check.status) && (check.accessEvidence || []).every((item) => item.outcome === "network-error")) {
        check.accessEvidence = (check.accessEvidence || []).map((item) => ({ ...item, requestedUrl: route }));
      }
    }
  }
}

function incompleteCount(checks) { return checks.filter((check) => ["accessible-incomplete", "temporarily-unavailable", "semantic-404", "failed"].includes(check.status)).length; }

// 聚合平台能先完成站内城市、关键词和资格预筛，但并非每条公开记录都
// 提供单位官网或独立投递页。不能凭单位名称猜官网，也不应让这类线索
// 永远卡在“待回溯”。因此：保留平台实际给出的直达链接；没有链接的
// 直接进入待用户确认清单，绝不混入已核验岗位。
function candidateFromDiscoveryLead(lead, sourceId, checkedAt) {
  const directUrl = lead.employerApplyUrl || null;
  const sourceUrl = lead.officialUrl;
  const hasDirectLink = Boolean(directUrl);
  return {
    id: `candidate-${sourceId}-${lead.id}`,
    track: "待确认线索",
    organization: lead.organization,
    employerNature: lead.employerNature || "平台未注明",
    title: lead.title,
    exactTitle: lead.title,
    location: lead.location,
    education: lead.education,
    majors: lead.majors,
    recruitmentType: lead.recruitmentType || "官方未注明",
    publishedAt: lead.publishedAt,
    deadline: lead.deadline,
    status: "待用户确认",
    priority: hasDirectLink ? 68 : 64,
    matchLevel: "待确认",
    matchReason: "已通过城市、应届硕士、单位性质和公开专业条件的脚本初筛；尚未取得可作为正式发布依据的单位或政府原文。",
    sourceId,
    sourceUrl,
    officialAnnouncementUrl: sourceUrl,
    officialApplyUrl: directUrl,
    verifiedAt: checkedAt,
    manualConfirmationRequired: true,
    manualConfirmationReason: hasDirectLink
      ? "平台公开提供了直达投递链接；请打开后核对单位、岗位条件和投递页面，再决定是否收藏或投递。"
      : "平台未公开提供单位官网或独立投递地址；请先查看平台原页，再自行核对单位官网或投递渠道。",
    backtracking: {
      status: hasDirectLink ? "platform-direct-link-provided" : "manual-confirmation-required",
      automaticResult: hasDirectLink ? "已保留平台提供的直达链接，不把它自动视为官方核验。" : "平台未返回可验证的单位直达链接，脚本不会猜测或搜索拼接官网。"
    },
    collectionEvidence: lead.evidence,
    tags: [sourceId === "national-college-employment" ? "国家大学生就业服务平台筛选" : "国聘/北航筛选", lead.employerNature || "平台未注明单位性质", "应届生", "专业条件可报", hasDirectLink ? "平台提供投递链接" : "需手动确认"]
  };
}

const NON_ACTIONABLE_NOTICE = /(拟聘|公示|取消|录用结果|面试(?:公告|名单|安排)|资格审查结果|笔试成绩|访谈|就业服务攻坚|人才培养计划|培训基地|实习实践)/;
const EXPERIENCED_ONLY_NOTICE = /(社会(?:公开)?招聘|成熟人才|博士后)/;
const EARLY_CAREER_NOTICE = /(校园|校招|应届|毕业生|管培|优才|公开招聘|招聘工作人员|选调|优培|招录)/;

function noticeCampaignIsCurrent(title, checkedAt) {
  const checkedYear = Number(checkedAt.slice(0, 4));
  const checkedMonth = Number(checkedAt.slice(5, 7));
  const targetGraduateYear = checkedMonth >= 8 ? checkedYear + 1 : checkedYear;
  const campaignYear = title.match(/(20\d{2})(?:届|年度)?(?:春季|夏季|秋季)?(?:校园招聘|校招)/)?.[1];
  return !campaignYear || Number(campaignYear) >= targetGraduateYear;
}

function monitorFromOfficialNotice(item, source, checkedAt) {
  const title = String(item.title || "").trim();
  if (!title || NON_ACTIONABLE_NOTICE.test(title)) return null;
  if (source.coverage?.includes("国有企业") && EXPERIENCED_ONLY_NOTICE.test(title) && !/(校园|校招|应届|毕业生)/.test(title)) return null;
  if (source.coverage?.includes("国有企业") && !noticeCampaignIsCurrent(title, checkedAt)) return null;
  if (!EARLY_CAREER_NOTICE.test(title)) return null;
  const track = source.coverage?.includes("事业单位") ? "事业单位"
    : source.coverage?.includes("国有企业") ? "央国企" : "招聘公告";
  return {
    id: `notice-${source.id}-${createHash("sha256").update(item.url).digest("hex").slice(0, 18)}`,
    track,
    title,
    status: "待查看职位表",
    note: "这是一则官方招聘公告；在职位表和报名条件拆分为具体岗位前，暂不列入岗位页。",
    officialUrl: item.url,
    checkedAt,
    sourceId: source.id
  };
}

async function main() {
  const [registry, recipes, sourcePlan, collectorRoutes, log, opportunities] = await Promise.all([
    readJson("data/source-registry.json"), readJson("data/filter-recipes.json"), readJson("data/source-plan.json"), readJson("data/collector-routes.json"), readJson("data/review-log.json"), readJson("data/opportunities.json")
  ]);
  const checkedAt = shanghaiMinute();
  const sources = new Map(registry.sources.map((source) => [source.id, source]));
  const collectionFetch = createCollectionFetch({
    maxAttempts: Math.max(sourcePlan.retryPolicy?.criticalMaxAttempts || 3, sourcePlan.retryPolicy?.activeMaxAttempts || 3),
    minHostIntervalMs: sourcePlan.requestPolicy?.minHostIntervalMs || 800,
    backoffMs: sourcePlan.requestPolicy?.backoffMs || [0, 1_500, 5_000],
    maxRetryAfterMs: sourcePlan.requestPolicy?.maxRetryAfterMs || 300_000,
    circuitCooldownMs: sourcePlan.requestPolicy?.circuitCooldownMs || 300_000
  });
  const [publicExamRun, buaa, iguopin, ncss, picc, boe, crc] = await Promise.all([
    buildPublicExamRun({ registry, recipes, checkedAt, fetchImpl: collectionFetch }),
    collectBuaaDiscovery({ city: recipes.city, fetchImpl: collectionFetch }).catch((error) => unavailableDiscoveryResult("buaa-career-discovery", error)),
    collectIGuopinDiscovery({ city: recipes.city, fetchImpl: collectionFetch }).catch((error) => unavailableDiscoveryResult("iguopin-discovery", error)),
    collectNCSSDiscovery({ city: recipes.city, fetchImpl: collectionFetch }).catch((error) => unavailableDiscoveryResult("national-college-employment", error)),
    collectPiccCampus({ city: recipes.city, fetchImpl: collectionFetch }).catch((error) => unavailableStructuredResult("picc-campus", error)),
    collectBoeCampus({ city: recipes.city, fetchImpl: collectionFetch }).catch((error) => unavailableStructuredResult("boe-campus", error)),
    collectCrcCareers({ city: recipes.city, fetchImpl: collectionFetch }).catch((error) => unavailableStructuredResult("crc-careers", error))
  ]);
  const structuredResults = new Map([picc, boe, crc].map((result) => [result.sourceId, result]));
  const publicExamChecks = new Map(publicExamRun.sourceChecks.map((check) => [check.sourceId, check]));
  const officialNoticeResults = new Map();
  const scheduledIds = [...new Set([...(sourcePlan.coverage.everyRunOfficial || []), ...(sourcePlan.coverage.everyRunDiscovery || [])])];
  const sourceChecks = await Promise.all(scheduledIds.map(async (sourceId) => {
    const source = sources.get(sourceId);
    if (!source) throw new Error(`source-plan 引用了不存在的来源：${sourceId}`);
    const route = collectorRoutes.routes?.[sourceId];
    if (!route?.collector) throw new Error(`完整更新拒绝隐式兜底：${sourceId} 没有登记采集器路由`);
    if (route.collector === "public-exam") {
      const check = publicExamChecks.get(sourceId);
      if (!check) throw new Error(`${sourceId} 已登记公考采集器，但本轮没有产生来源检查结果`);
      return check;
    }
    if (route.collector === "buaa-discovery") return discoverySourceCheck(source, buaa, checkedAt);
    if (route.collector === "iguopin-discovery") return discoverySourceCheck(source, iguopin, checkedAt);
    if (route.collector === "ncss-discovery") return discoverySourceCheck(source, ncss, checkedAt);
    if (route.collector === "picc-campus") return verifiedJobsSourceCheck(source, picc, checkedAt);
    if (route.collector === "boe-campus") return verifiedJobsSourceCheck(source, boe, checkedAt);
    if (route.collector === "crc-careers") return verifiedJobsSourceCheck(source, crc, checkedAt);
    if (route.collector === "official-notice-feed") {
      const result = await collectOfficialNoticeFeed({ source, fetchImpl: collectionFetch });
      officialNoticeResults.set(sourceId, result);
      return officialNoticeSourceCheck(result, checkedAt);
    }
    throw new Error(`${sourceId} 登记了不受支持的采集器：${route.collector}`);
  }));
  const incomplete = incompleteCount(sourceChecks);
  const publicMetrics = publicExamRun.screeningMetrics || {};
  const discoveryCandidates = [
    ...buaa.leads.map((lead) => candidateFromDiscoveryLead(lead, "buaa-career-discovery", checkedAt)),
    ...iguopin.leads.map((lead) => candidateFromDiscoveryLead(lead, "iguopin-discovery", checkedAt)),
    ...ncss.leads.map((lead) => candidateFromDiscoveryLead(lead, "national-college-employment", checkedAt))
  ].sort((left, right) => right.priority - left.priority || left.title.localeCompare(right.title, "zh-CN"));
  const officialNoticeMonitors = [...officialNoticeResults.entries()]
    .flatMap(([sourceId, result]) => (result.noticeItems || []).map((item) => monitorFromOfficialNotice(item, sources.get(sourceId), checkedAt)))
    .filter(Boolean);
  const run = {
    id: `run-${checkedAt.slice(0, 10).replaceAll("-", "")}-${checkedAt.slice(11, 16).replace(":", "")}-aggregate-first-full-sync`,
    scope: "full-city-run", checkedAt, trigger: "scheduled-or-manual-full-update", scheduledSourceIds: scheduledIds, policyVersion: 7,
    screeningStrategyVersion: 2, candidateProcessingVersion: 4,
    coverageStatus: "aggregate-first-collection-and-source-health",
    status: incomplete ? "completed-partial" : "completed",
    outcome: "aggregate-platform-discovery-plus-official-verification",
    summary: `本轮已执行公考、选调优培、三类聚合平台和重点单位的公开采集。北航就业信息网${buaa.collectionError ? "本轮未完成" : `初筛 ${buaa.leads.length} 条`}，国聘${iguopin.collectionError ? "本轮未完成" : `初筛 ${iguopin.leads.length} 条`}，国家大学生就业服务平台${ncss.collectionError ? "本轮未完成" : `初筛 ${ncss.leads.length} 条`}；重点官网具体岗位：中国人保 ${picc.collectionError ? "未完成" : picc.afterFilter + " 条"}、京东方 ${boe.collectionError ? "未完成" : boe.afterFilter + " 条"}、华润 ${crc.collectionError ? "未完成" : crc.afterFilter + " 条"}；官方公告页保留 ${officialNoticeMonitors.length} 条待拆分公告。`,
    metrics: {
      officialSystemsChecked: sourceChecks.length, officialSystemsSucceeded: sourceChecks.length - incomplete, officialSystemsFailed: incomplete,
      newLeads: (publicExamRun.metrics?.newLeads || 0) + buaa.leads.length + iguopin.leads.length + ncss.leads.length + officialNoticeMonitors.length + [...structuredResults.values()].reduce((sum, result) => sum + (result.jobs?.length || 0), 0),
      reviewedItems: publicExamRun.reviews.length, accepted: 0, rejected: 0, deferred: publicExamRun.reviews.length,
      published: [...structuredResults.values()].reduce((sum, result) => sum + (result.jobs?.length || 0), 0), updated: 0, closed: 0
    },
    screeningMetrics: {
      portalResultsReported: (publicMetrics.portalResultsReported || 0) + buaa.portalResultsReported + iguopin.portalResultsReported + ncss.portalResultsReported,
      nativeFilterQueries: (publicMetrics.nativeFilterQueries || 0) + buaa.nativeFilterQueries + iguopin.nativeFilterQueries + ncss.nativeFilterQueries,
      nativeFilteredResults: (publicMetrics.nativeFilteredResults || 0) + buaa.nativeFilteredResults + iguopin.nativeFilteredResults + ncss.nativeFilteredResults,
      deduplicatedCandidates: (publicMetrics.deduplicatedCandidates || 0) + buaa.deduplicatedCandidates + iguopin.deduplicatedCandidates + ncss.deduplicatedCandidates,
      positionsBatchReviewed: (publicMetrics.positionsBatchReviewed || 0) + buaa.detailsChecked + iguopin.detailsChecked + ncss.detailsChecked,
      positionsOfficiallyVerified: (publicMetrics.positionsOfficiallyVerified || 0) + [...structuredResults.values()].reduce((sum, result) => sum + (result.positionsOfficiallyVerified || 0), 0),
      positionsEscalated: 0, positionsDeferredByBudget: publicMetrics.positionsDeferredByBudget || 0,
      discoverySourcesChecked: 3, discoveryOfficialCandidates: buaa.leads.length + iguopin.leads.length + ncss.leads.length
    },
    networkPolicy: collectionFetch.stats(),
    sourceChecks, reviews: publicExamRun.reviews
  };
  if (!args.has("--write")) { console.log(JSON.stringify({ dryRun: true, city: recipes.city, run }, null, 2)); return; }
  normalizeCollectionMetrics(log, sources);
  log.meta.initializationStatus = "synchronized";
  log.meta.lastRunAt = checkedAt;
  log.runs = log.runs.filter((previous) => !previous.id?.endsWith("-full-route-audit") && previous.outcome !== "all-official-sources-checked" && previous.id !== run.id);
  log.runs.unshift(run);
  opportunities.meta.initializationStatus = "synchronized";
  opportunities.meta.lastVerifiedAt = checkedAt;
  opportunities.meta.lastRunStatus = run.status;
  opportunities.meta.lastIncompleteSourceCount = incomplete;
  opportunities.meta.lastDeferredCandidateCount = run.screeningMetrics.positionsDeferredByBudget;
  const structuredSourceIds = new Set(structuredResults.keys());
  const otherJobs = (opportunities.jobs || []).filter((job) => !structuredSourceIds.has(job.sourceId));
  const refreshedStructuredJobs = [...structuredResults.values()].flatMap((result) => result.collectionError
    ? (opportunities.jobs || []).filter((job) => job.sourceId === result.sourceId)
    : result.jobs);
  opportunities.jobs = [...otherJobs, ...refreshedStructuredJobs];
  opportunities.candidates = mergeDiscoveryCandidates(opportunities.candidates, discoveryCandidates, [buaa, iguopin, ncss]);
  opportunities.monitors = mergeOfficialMonitors(opportunities.monitors, officialNoticeMonitors, officialNoticeResults);
  await Promise.all([
    writeFile(new URL("data/review-log.json", root), `${JSON.stringify(log, null, 2)}\n`),
    writeFile(new URL("data/opportunities.json", root), `${JSON.stringify(opportunities, null, 2)}\n`)
  ]);
  console.log(JSON.stringify({ written: true, city: recipes.city, checkedAt, buaaLeads: buaa.leads.length, iguopinLeads: iguopin.leads.length, ncssLeads: ncss.leads.length, officialNoticeMonitors: officialNoticeMonitors.length, structured: Object.fromEntries([...structuredResults].map(([id, result]) => [id, { collected: result.collected ?? null, published: result.jobs?.length ?? null, error: result.collectionError || null }])), incomplete }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
