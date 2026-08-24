#!/usr/bin/env node
/**
 * Structured, no-login collector for 京企直聘.
 *
 * The platform is hosted by 北京市国资委 and exposes the same public JSON
 * endpoints used by its job-search page. We first apply the site's Beijing,
 * graduate, campus and state-owned-enterprise filters, then use the list's
 * official education/major fields to decide which public details are worth
 * opening. This deliberately avoids both the unfiltered portal corpus and a
 * narrow title-keyword search that would miss open-major roles.
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  evaluateProfessionalEligibility,
  matchLevelForPriority,
  mastersEducationEligible,
  objectiveRiskFlags,
  rankProfessionalOpportunity,
  roleIsProfileRelevant
} from "./professional-eligibility.mjs";

const ORIGIN = "https://jqzp.fesco.com.cn";
const ENTRY_URL = `${ORIGIN}/page?id=27`;
const POSITION_URL = `${ORIGIN}/position`;
const LIST_URL = `${ORIGIN}/api1/getPosition`;
const DETAIL_URL = `${ORIGIN}/api1/getPositionDetailed`;
const TENEMENT_ID = "ac377b5d9eaa406d9806930bedee9268";
const PAGE_SIZE = 100;
const BEIJING_CITY_ID = 33;
const GRADUATE_WORK_YEAR = 1;
const STATE_OWNED_QUALITY = 5;
const CAMPUS_RECRUITMENT = 2;
const REQUIRED_EXPERIENCE = /(?:[1-9]\d*\s*年|[一二三四五六七八九十]年)(?:及?以上)?[^。；，,\n]{0,12}(?:经验|经历)/i;
const LOW_EDUCATION_ONLY = /(大专|专科|高中|中专|技校)/;
const HARD_RISK = /(井下|矿山|海上作业|爆破|高海拔|有害暴露|长期夜班|长期倒班|长期驻外|重体力)/i;
const CLEARLY_LOW_QUALITY_ROLE = /(劳务外包|劳务派遣|外包岗位|操作工|装卸工|瓶箱保管员|仓储理货|保洁|保安|安保员|餐饮服务员|营业员|客服专员)/i;

export class JqzpBeijingSoeError extends Error {
  constructor(message) { super(message); this.name = "JqzpBeijingSoeError"; }
}

function clean(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function lines(value) {
  return String(value || "").replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, " ")
    .split(/\n+/).map(clean).filter(Boolean);
}

function shanghaiMinute(now = new Date()) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(now).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00+08:00`;
}

function today(now = new Date()) {
  return shanghaiMinute(now).slice(0, 10);
}

function profileEducationEligible(value) {
  const text = clean(value);
  if (LOW_EDUCATION_ONLY.test(text) && !/(本科|硕士|研究生|博士|不限)/.test(text)) return false;
  return mastersEducationEligible(text);
}

function splitDescription(value) {
  const text = String(value || "").replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, " ").trim();
  const dutyIndex = text.search(/岗位职责[：:]?/);
  if (dutyIndex < 0) return { requirements: lines(text), responsibilities: [] };
  return {
    requirements: lines(text.slice(0, dutyIndex).replace(/^任职要求[：:]?/, "")),
    responsibilities: lines(text.slice(dutyIndex).replace(/^岗位职责[：:]?/, ""))
  };
}

function uniqueLocation(row) {
  return [...new Set([row.workCityName, row.workDistrictName].map(clean).filter(Boolean))].join(" · ") || "北京市";
}

function headers(extra = {}) {
  return {
    accept: "application/json,text/plain,*/*",
    "content-type": "application/json;charset=utf-8",
    tenementId: TENEMENT_ID,
    ver: "1.0.3",
    referer: POSITION_URL,
    "user-agent": "Mozilla/5.0",
    ...extra
  };
}

async function requestJson(url, options, fetchImpl, attempts = 3) {
  const requestAttempts = fetchImpl.isResilientCollectionFetch ? 1 : attempts;
  let lastError;
  for (let attempt = 1; attempt <= requestAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        ...options,
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
        headers: headers(options?.headers)
      });
      const finalUrl = new URL(response.url || url);
      if (finalUrl.hostname !== "jqzp.fesco.com.cn") throw new JqzpBeijingSoeError("京企直聘公开请求跳转到未登记域名。");
      const payload = await response.json().catch(() => undefined);
      if (!response.ok || payload?.code !== 200) throw new JqzpBeijingSoeError(`京企直聘公开接口未返回成功状态（HTTP ${response.status}）。`);
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt < requestAttempts) await new Promise((resolve) => setTimeout(resolve, attempt * 300));
    }
  }
  throw lastError;
}

function listBody() {
  return {
    salaryId: "",
    workYear: GRADUATE_WORK_YEAR,
    workCityId: BEIJING_CITY_ID,
    otherCityId: "",
    workProvinceId: "",
    degreeId: "",
    companyScale: "",
    industry: "",
    businessQuality: STATE_OWNED_QUALITY,
    workDistrictId: "",
    classId: "",
    recruitmentType: CAMPUS_RECRUITMENT,
    jobPostingType: "2",
    majorId: ""
  };
}

async function requestPage(pageIndex, fetchImpl) {
  const url = `${LIST_URL}?${new URLSearchParams({ from: String(pageIndex), size: String(PAGE_SIZE), searchWord: "" })}`;
  const payload = await requestJson(url, { method: "POST", body: JSON.stringify(listBody()) }, fetchImpl);
  if (!Array.isArray(payload.data) || !Number.isInteger(Number(payload.count))) throw new JqzpBeijingSoeError("京企直聘职位列表未返回完整分页结构。");
  return { url, rows: payload.data, count: Number(payload.count) };
}

async function requestDetail(postId, fetchImpl) {
  const url = `${DETAIL_URL}?${new URLSearchParams({ postId: String(postId) })}`;
  const payload = await requestJson(url, { method: "POST" }, fetchImpl);
  if (!Array.isArray(payload.data) || payload.data.length !== 1) throw new JqzpBeijingSoeError(`京企直聘岗位 ${postId} 未返回唯一公开详情。`);
  return { url, row: payload.data[0] };
}

function listPrefilter(row, now = new Date()) {
  if (!row?.id) return { outcome: "invalid-row" };
  if (!/北京/.test(clean(row.workCityName))) return { outcome: "location-mismatch" };
  if (!/国有企业/.test(clean(row.businessQualityName))) return { outcome: "employer-nature-mismatch" };
  if (!/(校园招聘)/.test(clean(row.recruitmentTypeName)) || !/(应届生)/.test(clean(row.workYearName))) return { outcome: "non-graduate-recruitment" };
  const deadline = clean(row.orderEndTime).slice(0, 10);
  if (deadline && deadline < today(now)) return { outcome: "expired" };
  if (!profileEducationEligible(row.degreeName)) return { outcome: "education-mismatch" };
  const eligibility = evaluateProfessionalEligibility(row.majorName);
  if (!eligibility.eligible && eligibility.basis !== "missing") return { outcome: `professional-${eligibility.basis}` };
  return { outcome: "detail-required" };
}

export function classifyJqzpDetail(row, checkedAt, now = new Date()) {
  if (!row?.id || Number(row.publishStatus) !== 2 || Number(row.offlineFlag || 0) !== 0) return { outcome: "not-active" };
  if (!/北京/.test(clean(`${row.workCityName} ${row.cityName}`))) return { outcome: "location-mismatch" };
  if (!/国有企业/.test(clean(row.businessQualityName))) return { outcome: "employer-nature-mismatch" };
  if (Number(row.recruitmentType) !== CAMPUS_RECRUITMENT || Number(row.workYear) !== GRADUATE_WORK_YEAR) return { outcome: "non-graduate-recruitment" };
  const deadline = clean(row.orderEndTime).slice(0, 10);
  if (deadline && deadline < today(now)) return { outcome: "expired" };
  if (!profileEducationEligible(row.degreeName)) return { outcome: "education-mismatch" };
  const eligibility = evaluateProfessionalEligibility(`${row.majorName || ""} ${row.require || ""}`);
  if (!eligibility.eligible) return { outcome: `professional-${eligibility.basis}`, reason: eligibility.reason };
  const description = clean(row.description);
  if (REQUIRED_EXPERIENCE.test(description)) return { outcome: "experience-mismatch" };
  const parsed = splitDescription(row.description);
  // 专业资格属于“能否报名”的证据，不能被误当作岗位具有生物医学
  // 应用场景的证据。纯计算机岗位只看岗位名称、类别与职责部分。
  const roleText = clean(`${row.publicName} ${row.className} ${parsed.responsibilities.join(" ")}`);
  if (!roleIsProfileRelevant(roleText)) return { outcome: "pure-computing-role-mismatch" };
  if (HARD_RISK.test(roleText)) return { outcome: "objective-high-risk" };
  if (CLEARLY_LOW_QUALITY_ROLE.test(roleText)) return { outcome: "clearly-low-quality-role" };
  const risks = objectiveRiskFlags(roleText);
  if (/劳务外包|劳务派遣|外包岗位/.test(roleText)) risks.push("劳务外包/派遣");
  const overseasRisk = /(海外|驻外|出差)/.test(roleText);
  if (overseasRisk) risks.push("岗位涉及海外业务、驻外或出差，需确认实际频率");
  const priority = Math.max(35, rankProfessionalOpportunity(eligibility, roleText) - (overseasRisk ? 8 : 0));
  const matchLevel = matchLevelForPriority(priority, eligibility);
  const starts = clean(row.orderStartTime).slice(0, 10);
  const upcoming = starts && starts > today(now);
  const detailUrl = `${ORIGIN}/positiondetails?infoid=${encodeURIComponent(Buffer.from(String(row.id)).toString("base64"))}`;
  return {
    outcome: "accepted",
    job: {
      id: `jqzp-${row.id}`,
      track: "央国企",
      subtrack: "北京市属国企",
      organization: clean(row.businessName) || "官方未注明",
      department: clean(row.businessName) || "官方未单列",
      title: clean(row.publicName) || "具体岗位",
      exactTitle: clean(row.publicName) || "具体岗位",
      jobCode: String(row.id),
      location: uniqueLocation(row),
      cohort: "应届校园招聘",
      recruitmentType: clean(row.recruitmentTypeName) || "校园招聘",
      headcount: Number(row.number) > 0 ? String(row.number) : "官方未注明",
      education: clean(row.degreeName) || "官方未注明",
      degree: clean(row.degreeName) || "以官方岗位条件为准",
      majors: clean(row.majorName) || eligibility.evidence || "官方未单列",
      politicalStatus: "官方未单列",
      experience: "应届生岗位；已排除正文中明确要求工作经验的记录",
      responsibilities: parsed.responsibilities.length ? parsed.responsibilities : ["官方未单列"],
      requirements: parsed.requirements.length ? parsed.requirements : ["官方未单列"],
      publishedAt: starts || clean(row.refreshTime).slice(0, 10) || "官方未注明",
      deadline: deadline || "岗位招满即停，以京企直聘实时状态为准",
      deadlineType: deadline ? "平台岗位截止日" : "动态截止",
      status: upcoming ? "即将开放" : "招聘中",
      priority,
      matchLevel,
      matchReason: `${eligibility.reason}（命中“${eligibility.evidence}”）；岗位由京企直聘公开接口返回，已完成北京、应届、校招、国企和任职条件核验。`,
      riskNotes: [...new Set(risks)].map((risk) => `公开岗位信息提示：${risk}`),
      tags: ["北京", "北京市属国企", eligibility.evidence, matchLevel].filter(Boolean),
      sourceId: "jqzp-beijing-soe",
      officialAnnouncementUrl: ENTRY_URL,
      officialApplyUrl: detailUrl,
      applyInstruction: "打开京企直聘岗位详情，登录后按平台流程投递",
      verifiedAt: checkedAt,
      lastSeenAt: checkedAt,
      lastSeenStatus: "live",
      statusEvidence: "京企直聘公开接口当前返回的北京市属国企应届校园招聘岗位。",
      professionalEligibility: eligibility,
      verifiedFields: ["具体岗位", "单位性质", "地点", "招聘类型", "学历", "专业", "任职条件", "投递路径", "截止日期"],
      verification: { officialSource: true, specificPosition: true, location: true, eligibility: true, applicationPath: true, deadlineChecked: true }
    }
  };
}

export async function collectJqzpBeijingSoe({ city, fetchImpl = fetch, now = new Date() } = {}) {
  if (city !== "北京") throw new JqzpBeijingSoeError("京企直聘只登记为北京城市来源。");
  const checkedAt = shanghaiMinute(now);
  const first = await requestPage(0, fetchImpl);
  const totalPages = Math.max(1, Math.ceil(first.count / PAGE_SIZE));
  if (totalPages > 100) throw new JqzpBeijingSoeError(`京企直聘原生筛选结果异常扩大到 ${totalPages} 页，已停止以避免扫描未筛选全集。`);
  const rows = [...first.rows];
  const pagesVisited = [first.url];
  for (let pageIndex = 1; pageIndex < totalPages; pageIndex += 1) {
    const page = await requestPage(pageIndex, fetchImpl);
    rows.push(...page.rows);
    pagesVisited.push(page.url);
  }
  const unique = [...new Map(rows.filter((row) => row?.id).map((row) => [String(row.id), row])).values()];
  const detailCandidates = [];
  const outcomes = {};
  for (const row of unique) {
    const result = listPrefilter(row, now);
    outcomes[result.outcome] = (outcomes[result.outcome] || 0) + 1;
    if (result.outcome === "detail-required") detailCandidates.push(row);
  }
  const jobs = [];
  for (const candidate of detailCandidates) {
    const detail = await requestDetail(candidate.id, fetchImpl);
    pagesVisited.push(detail.url);
    const result = classifyJqzpDetail(detail.row, checkedAt, now);
    outcomes[result.outcome] = (outcomes[result.outcome] || 0) + 1;
    if (result.job) jobs.push(result.job);
  }
  jobs.sort((left, right) => right.priority - left.priority || left.title.localeCompare(right.title, "zh-CN"));
  return {
    sourceId: "jqzp-beijing-soe",
    city,
    collectionMethod: "script",
    collectionRoute: "京企直聘公开接口 → 北京＋应届生＋校园招聘＋国有企业 → 全部分页 → 列表专业/学历预筛 → 公开详情资格核验",
    status: "checked-native-filtered",
    portalResultsReported: first.count,
    nativeFilterQueries: 1,
    nativeFilteredResults: unique.length,
    deduplicatedCandidates: unique.length,
    detailsChecked: detailCandidates.length,
    positionsOfficiallyVerified: jobs.length,
    collected: unique.length,
    afterFilter: jobs.length,
    detailOutcomes: outcomes,
    jobs,
    pagesVisited,
    filterEvidence: {
      city: "北京", cityId: BEIJING_CITY_ID, workYear: "应届生", workYearId: GRADUATE_WORK_YEAR,
      recruitmentType: "校园招聘", recruitmentTypeId: CAMPUS_RECRUITMENT,
      employerNature: "国有企业", businessQualityId: STATE_OWNED_QUALITY,
      pageSize: PAGE_SIZE, totalPages,
      professionalGate: "列表官方专业/学历字段预筛，公开详情二次资格核验"
    }
  };
}

async function defaultCity() {
  const data = JSON.parse(await readFile(new URL("../data/filter-recipes.json", import.meta.url), "utf8"));
  return data.city;
}

async function main() {
  const index = process.argv.indexOf("--city");
  const city = index >= 0 ? process.argv[index + 1] : await defaultCity();
  console.log(JSON.stringify(await collectJqzpBeijingSoe({ city }), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: "jqzp-beijing-soe-failed", error: error.message }, null, 2));
    process.exitCode = 1;
  });
}
