#!/usr/bin/env node
/** Structured, no-login collector for BOE's official campus portal. */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { evaluateProfessionalEligibility, matchLevelForPriority, mastersEducationEligible, objectiveRiskFlags, rankProfessionalOpportunity, roleIsProfileRelevant } from "./professional-eligibility.mjs";

const ORIGIN = "https://campus.boe.com";
const ENTRY_URL = `${ORIGIN}/jobs?hideMenu=1`;
const LIST_URL = `${ORIGIN}/api/Jobad/GetJobAdPageList`;
const AREA_URL = `${ORIGIN}/api/Jobad/SearchAreasTreeConditions`;
const CAMPUS_CATEGORY = 15;
const CITY_CODES = { "北京": "1100", "上海": "3100", "广州": "4401", "深圳": "4403" };
const PAGE_SIZE = 100;
const DISPLAY_FIELDS = ["JobAdName", "Org", "LocId", "LocNames", "Category", "Degree", "PostDate", "EndTime", "Duty", "Require", "HeadCount", "DetailAddress"];

export class BoeCampusError extends Error { constructor(message) { super(message); this.name = "BoeCampusError"; } }
function clean(value) { return String(value || "").replace(/\u00a0/g, " ").replace(/<[^>]+>/g, " ").replace(/\r/g, "").replace(/[ \t]+/g, " ").trim(); }
function shanghaiMinute(now = new Date()) {
  const parts = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(now).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00+08:00`;
}
function lines(value) { return clean(value).split(/\n+(?=\d+[.、]\s*)|\n+/).map(clean).filter(Boolean); }
function codeFromTitle(value, fallback) { return clean(value).match(/\((J\d+)\)/i)?.[1]?.toUpperCase() || String(fallback); }
function shortTitle(value) { return clean(value).replace(/\((J\d+)\).*$/i, "").replace(/^【[^】]+】/, "") || "具体岗位"; }
function majorLines(requirement) { const selected = lines(requirement).filter((item) => /专业|学科|工学|理工|医学|生物|不限/.test(item)); return selected.join("；") || clean(requirement); }
function educationText(requirement) { return lines(requirement).find((item) => /(本科|硕士|研究生|博士|学历)/.test(item)) || "官方任职条件未单列学历"; }
function retryDelay(attempt) { return new Promise((resolve) => setTimeout(resolve, attempt * 250)); }

async function request(url, options, fetchImpl, attempts = 3) {
  let lastError;
  const requestAttempts = fetchImpl.isResilientCollectionFetch ? 1 : attempts;
  for (let attempt = 1; attempt <= requestAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { ...options, redirect: "follow", signal: AbortSignal.timeout(30_000), headers: { accept: "application/json,text/html", "user-agent": "Mozilla/5.0", referer: ENTRY_URL, ...(options?.headers || {}) } });
      if (response.url && new URL(response.url).hostname !== "campus.boe.com") throw new BoeCampusError("京东方公开请求跳转到未登记域名。");
      if (!response.ok) throw new BoeCampusError(`京东方公开接口返回 HTTP ${response.status}。`);
      return response;
    } catch (error) { lastError = error; if (attempt < requestAttempts) await retryDelay(attempt); }
  }
  throw lastError;
}

async function bootstrap(fetchImpl) {
  const response = await request(ENTRY_URL, { headers: { accept: "text/html" } }, fetchImpl);
  const html = await response.text();
  const portalId = html.match(/["']PortalId["']\s*:\s*["']([0-9a-f-]{36})/i)?.[1];
  if (!portalId) throw new BoeCampusError("京东方首页未返回可核验的 PortalId。");
  return { portalId, finalUrl: response.url || ENTRY_URL };
}

async function cityAvailable(city, code, portalId, fetchImpl) {
  const url = `${AREA_URL}?${new URLSearchParams({ PortalId: portalId, categoryId: String(CAMPUS_CATEGORY) })}`;
  const response = await request(url, {}, fetchImpl);
  const payload = await response.json();
  if (payload?.Code !== 200 || !Array.isArray(payload.Data)) throw new BoeCampusError("京东方地点筛选接口未返回完整结构。");
  return { url, available: payload.Data.some((item) => String(item.Code) === code && String(item.Name?.[0] || "").includes(city)) };
}

async function requestPage({ portalId, code, pageIndex }, fetchImpl) {
  const body = { PageIndex: pageIndex, PageSize: PAGE_SIZE, KeyWords: "", SpecialType: 0, PortalId: portalId, Category: [CAMPUS_CATEGORY], LocId: [Number(code)], DisplayFields: DISPLAY_FIELDS };
  const response = await request(LIST_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, fetchImpl);
  const payload = await response.json();
  if (payload?.Code !== 200 || !Array.isArray(payload.Data) || !Number.isInteger(Number(payload.Count))) throw new BoeCampusError("京东方职位列表未返回完整分页结构。");
  return payload;
}

export function classifyBoeRow(row, city, checkedAt) {
  if (!row?.JobAdId) return { outcome: "invalid-row" };
  const title = clean(row.JobAdName);
  if (/(实习|intern)/i.test(title)) return { outcome: "internship" };
  const location = (row.LocNames || []).map(clean).filter(Boolean).join("；");
  if (!location.includes(city)) return { outcome: "location-mismatch" };
  const requirement = clean(row.Require);
  if (!mastersEducationEligible(requirement)) return { outcome: "education-mismatch" };
  const eligibility = evaluateProfessionalEligibility(requirement);
  if (!eligibility.eligible) return { outcome: `professional-${eligibility.basis}`, reason: eligibility.reason };
  const roleText = clean(`${row.JobAdName} ${row.Duty}`);
  if (!roleIsProfileRelevant(roleText)) return { outcome: "pure-computing-role-mismatch" };
  const jobCode = codeFromTitle(row.JobAdName, row.JobAdId);
  const risks = objectiveRiskFlags(roleText);
  const priority = rankProfessionalOpportunity(eligibility, roleText);
  const level = matchLevelForPriority(priority, eligibility);
  const end = String(row.EndTime || "").slice(0, 10);
  const deadline = end && !/^2222-/.test(end) ? end : "岗位招满即停，以官方招聘系统实时状态为准";
  return { outcome: "accepted", job: {
    id: `boe-${jobCode.toLowerCase()}`, track: "央国企", subtrack: "先进制造", organization: clean(row.Org) || "京东方科技集团股份有限公司",
    department: clean(row.Org) || "官方未单列", title: shortTitle(row.JobAdName), exactTitle: title, jobCode, location,
    cohort: "应届校园招聘", recruitmentType: clean(row.Category) || "校园招聘", headcount: Number(row.HeadCount) > 0 ? String(row.HeadCount) : "官方未注明",
    education: educationText(requirement), degree: "以官方岗位条件为准", majors: majorLines(requirement), politicalStatus: "官方未单列", experience: "应届生岗位",
    responsibilities: lines(row.Duty), requirements: lines(row.Require), publishedAt: String(row.PostDate || "").slice(0, 10) || "官方未注明",
    deadline, deadlineType: /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? "官方岗位截止日" : "动态截止", status: "招聘中",
    priority, matchLevel: level, matchReason: `${eligibility.reason}（命中“${eligibility.evidence}”）；已排除无生物医学交叉的纯计算机岗位，其他岗位内容只影响排序。`,
    riskNotes: risks.length ? [`官方职责出现客观工作强度/环境提示：${risks.join("、")}`] : [], tags: [city, eligibility.evidence, level].filter(Boolean),
    sourceId: "boe-campus", officialAnnouncementUrl: ENTRY_URL, officialApplyUrl: `${ORIGIN}/15/detail?jobAdId=${encodeURIComponent(row.JobAdId)}&hideMenu=1`,
    applyInstruction: `打开京东方官方岗位页并核对职位代码 ${jobCode}`, verifiedAt: checkedAt, lastSeenAt: checkedAt, lastSeenStatus: "live",
    statusEvidence: "京东方官方校园招聘接口按招聘分类和工作地点返回的在招岗位。", professionalEligibility: eligibility,
    verifiedFields: ["职位代码", "单位", "地点", "学历", "专业", "职责", "投递路径", "截止口径"],
    verification: { officialSource: true, specificPosition: true, location: true, eligibility: true, applicationPath: true, deadlineChecked: true }
  }};
}

export async function collectBoeCampus({ city, fetchImpl = fetch, now = new Date() } = {}) {
  const code = CITY_CODES[city];
  if (!code) throw new BoeCampusError(`京东方采集器未登记城市：${city}`);
  const checkedAt = shanghaiMinute(now);
  const boot = await bootstrap(fetchImpl);
  const area = await cityAvailable(city, code, boot.portalId, fetchImpl);
  if (!area.available) return {
    sourceId: "boe-campus", city, collectionMethod: "script", collectionRoute: "京东方官方校园招聘 API → 校园招聘分类 → 官方地点选项",
    status: "checked-native-filtered", portalResultsReported: 0, nativeFilterQueries: 2, nativeFilteredResults: 0, deduplicatedCandidates: 0,
    detailsChecked: 0, positionsOfficiallyVerified: 0, collected: 0, afterFilter: 0, detailOutcomes: { "official-city-option-absent": 1 },
    jobs: [], pagesVisited: [boot.finalUrl, area.url], filterEvidence: { city, cityCode: code, categoryId: CAMPUS_CATEGORY, officialCityOptionAvailable: false }
  };
  const first = await requestPage({ portalId: boot.portalId, code, pageIndex: 0 }, fetchImpl);
  const totalPages = Math.max(1, Math.ceil(Number(first.Count) / PAGE_SIZE));
  const rows = [...first.Data];
  for (let pageIndex = 1; pageIndex < totalPages; pageIndex += 1) rows.push(...(await requestPage({ portalId: boot.portalId, code, pageIndex }, fetchImpl)).Data);
  const unique = [...new Map(rows.map((row) => [String(row.JobAdId), row])).values()];
  const jobs = [], outcomes = {};
  for (const row of unique) { const result = classifyBoeRow(row, city, checkedAt); outcomes[result.outcome] = (outcomes[result.outcome] || 0) + 1; if (result.job) jobs.push(result.job); }
  jobs.sort((a, b) => b.priority - a.priority || a.title.localeCompare(b.title, "zh-CN"));
  return {
    sourceId: "boe-campus", city, collectionMethod: "script", collectionRoute: "京东方官方校园招聘 API → 校园招聘分类 → 官方地点筛选 → 全部分页 → 任职条件专业资格门禁",
    status: "checked-native-filtered", portalResultsReported: Number(first.Count), nativeFilterQueries: 2, nativeFilteredResults: unique.length,
    deduplicatedCandidates: unique.length, detailsChecked: unique.length, positionsOfficiallyVerified: jobs.length, collected: unique.length, afterFilter: jobs.length,
    detailOutcomes: outcomes, jobs, pagesVisited: [boot.finalUrl, area.url, ...Array.from({ length: totalPages }, (_, index) => `${LIST_URL}#city=${code}&category=${CAMPUS_CATEGORY}&page=${index}`)],
    filterEvidence: { city, cityCode: code, categoryId: CAMPUS_CATEGORY, pageSize: PAGE_SIZE, totalPages, professionalGate: "only-official-major-requirements" }
  };
}

async function defaultCity() { const data = JSON.parse(await readFile(new URL("../data/filter-recipes.json", import.meta.url), "utf8")); return data.city; }
async function main() { const index = process.argv.indexOf("--city"); const city = index >= 0 ? process.argv[index + 1] : await defaultCity(); console.log(JSON.stringify(await collectBoeCampus({ city }), null, 2)); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(JSON.stringify({ status: "boe-campus-failed", error: error.message }, null, 2)); process.exitCode = 1; });
