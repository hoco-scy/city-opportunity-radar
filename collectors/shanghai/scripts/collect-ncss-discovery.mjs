#!/usr/bin/env node
/**
 * Collect public, no-login, city-filtered listings from the 国家大学生就业服务平台.
 *
 * This collector intentionally uses the exact list endpoint used by the public
 * job-list page.  It never falls back to its unfiltered catalogue, and it does
 * not attempt to submit an application or access account-only information.
 * Results are discovery leads only: a platform record is not publication
 * evidence for a verified job.
 */
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { evaluateProfessionalEligibility, mastersEducationEligible, roleIsProfileRelevant } from "./professional-eligibility.mjs";

const ORIGIN = "https://www.ncss.cn";
const LIST_URL = `${ORIGIN}/student/jobs/jobslist/ajax/`;
const CITY_FILTERS = {
  "北京": "110100",
  "上海": "310100",
  "广州": "440100",
  "深圳": "440300"
};
// Search explicit eligibility rather than vaguely adjacent job domains.
export const DISCOVERY_KEYWORDS = Object.freeze(["生物医学工程", "生物医工", "医学工程", "工学", "理工类", "专业不限"]);
const PAGE_SIZE = 20;
const PERSISTENT_DETAIL_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const NON_GRADUATE_RECRUITMENT = /(社招|社会招聘|实习|兼职)/i;
const REQUIRED_EXPERIENCE = /(?:[1-9]\d*\s*年|[一二三四五六七八九十]年)(?:及以上)?(?:工作|相关|从业)经验/i;
const TARGET_EMPLOYER_NATURE = /(国企|国有企业|中央企业|事业单位)/;

export class NCSSDiscoveryError extends Error {
  constructor(message) { super(message); this.name = "NCSSDiscoveryError"; }
}

function cityFilter(city) {
  const filter = CITY_FILTERS[city];
  if (!filter) throw new NCSSDiscoveryError(`国家大学生就业服务平台未登记城市筛选码：${city}`);
  return filter;
}

function text(value) { return String(value || "").replace(/\s+/g, " ").trim(); }

function stripHtml(value) {
  return text(String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">"));
}

function dateFromEpoch(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "官方未注明";
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(number));
}

function detailUrl(jobId) {
  return `${ORIGIN}/student/jobs/${encodeURIComponent(jobId)}/detail.html`;
}

function listUrl({ areaCode, keyword, offset }) {
  const url = new URL(LIST_URL);
  url.search = new URLSearchParams({ areaCode, jobName: keyword, offset: String(offset), limit: String(PAGE_SIZE) });
  return url;
}

async function requestList({ areaCode, keyword, offset }, fetchImpl) {
  const url = listUrl({ areaCode, keyword, offset });
  const response = await fetchImpl(url, {
    headers: { accept: "application/json", "user-agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(30_000)
  });
  if (response.url && new URL(response.url).hostname !== "www.ncss.cn") throw new NCSSDiscoveryError("国家大学生就业服务平台列表请求跳转到未登记域名，已停止采集。");
  const payload = await response.json().catch(() => undefined);
  const accessMessage = (payload?.global || []).map((item) => item?.des).filter(Boolean).join("；");
  if (!response.ok || payload?.flag !== true || !Array.isArray(payload?.data?.list)) {
    if (/登录|验证码|访问控制/.test(accessMessage)) throw new NCSSDiscoveryError(`国家大学生就业服务平台在第 ${offset} 页要求登录，公开采集在此前分页停止。`);
    throw new NCSSDiscoveryError(`国家大学生就业服务平台公开列表接口未返回成功状态（HTTP ${response.status}）。`);
  }
  return { payload: payload.data, url: url.toString() };
}

function persistentDetailOptions(job) {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ id: job.jobId, title: job.jobName, organization: job.recName, major: job.major, updatedAt: job.updateDate || job.publishDate }))
    .digest("hex");
  return { radarCacheScope: "persistent", radarCacheKey: `ncss-detail:${fingerprint}`, radarCacheTtlMs: PERSISTENT_DETAIL_TTL_MS };
}

async function requestDetail(job, fetchImpl) {
  const url = detailUrl(job.jobId);
  const response = await fetchImpl(url, {
    headers: { accept: "text/html", "user-agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(30_000),
    ...persistentDetailOptions(job)
  });
  if (response.url && new URL(response.url).hostname !== "www.ncss.cn") throw new NCSSDiscoveryError("国家大学生就业服务平台详情请求跳转到未登记域名，已停止采集。");
  const html = await response.text();
  if (!response.ok || !/<title>[^<]+-国家大学生就业服务平台<\/title>/i.test(html)) {
    throw new NCSSDiscoveryError(`国家大学生就业服务平台公开详情页未返回有效职位正文（HTTP ${response.status}）。`);
  }
  return stripHtml(html);
}

function preliminaryOutcome(job) {
  const nature = text(job.recProperty);
  if (!TARGET_EMPLOYER_NATURE.test(nature)) return { outcome: "employer-nature-mismatch" };
  const qualifications = [job.degreeName, job.major].filter(Boolean).join(" ");
  if (!mastersEducationEligible(qualifications)) return { outcome: "academic-degree-mismatch" };
  if (/(中专|专科)(?!及以上.*(?:本科|硕士|研究生))/.test(text(job.degreeName))) return { outcome: "academic-degree-mismatch" };
  const professionalEligibility = evaluateProfessionalEligibility(qualifications);
  if (!professionalEligibility.eligible) return { outcome: "no-eligible-major-evidence" };
  return { outcome: "needs-detail", professionalEligibility };
}

function classify(job, detail) {
  const nature = text(job.recProperty);
  const qualifications = [job.degreeName, job.major].filter(Boolean).join(" ");
  const roleText = [job.jobName, job.recName, detail].filter(Boolean).join(" ").replace(/医疗保险|补充医疗|社会保险|五险一金/g, " ");
  if (NON_GRADUATE_RECRUITMENT.test(roleText)) return { outcome: "non-graduate-recruitment" };
  if (REQUIRED_EXPERIENCE.test(roleText)) return { outcome: "experience-mismatch" };
  if (!roleIsProfileRelevant(roleText)) return { outcome: "pure-computing-role-mismatch" };
  const professionalEligibility = evaluateProfessionalEligibility(qualifications);
  return {
    outcome: "candidate",
    lead: {
      id: String(job.jobId),
      title: text(job.jobName) || "官方未注明",
      organization: text(job.recName) || "官方未注明",
      employerNature: nature,
      location: text(job.areaCodeName) || "官方未注明",
      education: text(job.degreeName) || "官方未注明",
      majors: text(job.major) || "官方未注明",
      recruitmentType: "国家大学生就业服务平台公开职位",
      publishedAt: dateFromEpoch(job.publishDate || job.updateDate),
      deadline: "平台未注明",
      officialUrl: detailUrl(job.jobId),
      employerApplyUrl: null,
      professionalEligibility,
      evidence: "国家大学生就业服务平台公开职位列表经城市、专业资格与纯计算机交叉场景筛选；仍需用户核对单位官方投递页。"
    }
  };
}

function increment(outcomes, outcome) { outcomes[outcome] = (outcomes[outcome] || 0) + 1; }

export async function collectNCSSDiscovery({ city, fetchImpl = fetch, maxPagesPerQuery = 10 } = {}) {
  const areaCode = cityFilter(city);
  const raw = new Map();
  const pagesVisited = [];
  const queries = [];
  let portalResultsReported = 0;
  let nativeFilteredResults = 0;
  let truncated = false;
  let partialReason = null;
  let publicPageCeiling = maxPagesPerQuery;

  for (const keyword of DISCOVERY_KEYWORDS) {
    const first = await requestList({ areaCode, keyword, offset: 1 }, fetchImpl);
    const pagination = first.payload.pagenation || {};
    const reported = Number(pagination.count || first.payload.list.length || 0);
    // The current API can report its capped catalogue count even when this
    // exact city/keyword query returns an empty first page.  An empty native
    // result is already complete; following its synthetic page count would
    // turn a genuine zero into a spurious request failure.
    const totalPages = first.payload.list.length
      ? Math.max(1, Number(pagination.total || Math.ceil(reported / PAGE_SIZE) || 1))
      : 1;
    const pageLimit = Math.min(totalPages, maxPagesPerQuery, publicPageCeiling);
    portalResultsReported += reported;
    nativeFilteredResults += reported;
    if (pageLimit < totalPages) truncated = true;
    let pagesRead = 1;
    const add = (payload) => (payload.list || []).forEach((job) => job?.jobId && raw.set(String(job.jobId), job));
    add(first.payload);
    pagesVisited.push(first.url);
    for (let offset = 2; offset <= pageLimit; offset += 1) {
      try {
        const next = await requestList({ areaCode, keyword, offset }, fetchImpl);
        add(next.payload);
        pagesVisited.push(next.url);
        pagesRead = offset;
      } catch (error) {
        if (!/要求登录/.test(error?.message || "")) throw error;
        truncated = true;
        partialReason ||= error.message;
        publicPageCeiling = Math.min(publicPageCeiling, offset - 1);
        break;
      }
    }
    queries.push({ keyword, total: reported, pagesRead });
  }

  const leads = [];
  const detailOutcomes = {};
  let detailsChecked = 0;
  for (const job of raw.values()) {
    const preliminary = preliminaryOutcome(job);
    if (preliminary.outcome !== "needs-detail") {
      increment(detailOutcomes, preliminary.outcome);
      continue;
    }
    const detail = await requestDetail(job, fetchImpl);
    detailsChecked += 1;
    const classified = classify(job, detail);
    increment(detailOutcomes, classified.outcome);
    if (classified.lead) leads.push(classified.lead);
  }
  return {
    sourceId: "national-college-employment",
    city,
    collectionMethod: "script",
    collectionRoute: "国家大学生就业服务平台公开城市＋专业可报关键词并集 → 已筛选分页 → 任职条件专业资格预筛",
    portalResultsReported,
    nativeFilterQueries: DISCOVERY_KEYWORDS.length,
    nativeFilteredResults,
    deduplicatedCandidates: raw.size,
    detailsChecked,
    detailOutcomes,
    leads,
    truncated,
    partialReason,
    queries,
    pagesVisited
  };
}

async function main() {
  const cityIndex = process.argv.indexOf("--city");
  const city = cityIndex >= 0 ? process.argv[cityIndex + 1] : "北京";
  console.log(JSON.stringify(await collectNCSSDiscovery({ city }), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(JSON.stringify({ status: "ncss-discovery-failed", error: error.message }, null, 2)); process.exitCode = 1; });
}
