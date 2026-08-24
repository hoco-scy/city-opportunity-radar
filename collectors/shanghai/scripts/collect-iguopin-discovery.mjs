#!/usr/bin/env node
/**
 * Read the public no-login 国聘 jobs API used by the web job-list page.
 *
 * This is a discovery collector only. It applies the platform's own city and
 * keyword filters before following result pages, then returns leads for an
 * employer or government-source verification step. A 国聘 listing itself is
 * never treated as final publication evidence.
 */
import { pathToFileURL } from "node:url";
import { evaluateProfessionalEligibility, mastersEducationEligible, roleIsProfileRelevant } from "./professional-eligibility.mjs";

const ORIGIN = "https://www.iguopin.com";
const LIST_URL = "https://gp-api.iguopin.com/api/jobs/v1/recom-job";
const CITY_FILTERS = {
  "北京": "000000.110000",
  "上海": "000000.310000",
  "广州": "000000.440000.440100",
  "深圳": "000000.440000.440300"
};
const KEYWORDS = ["生物医学工程", "医学工程", "生物工程", "医疗器械", "医学影像", "仪器", "电子信息", "自动化", "工程类", "理工类", "专业不限"];
const PAGE_SIZE = 20;
const BIOMEDICAL_CONTEXT = /(生物医学|医疗器械|医学影像|临床工程|体外诊断|IVD|生物信号|医疗|健康|生物工程|生命科学)/i;
const ENGINEERING_QUALIFICATION = /(生物医学工程|医学工程|医疗器械|医学影像|生物工程|临床工程|仪器|电子|自动化|机械|材料|物理|工学|理工)/i;
const DIRECT_BIOMEDICAL_BRIDGE = /(生物医学工程|医学工程|医疗器械|医学影像|临床工程|体外诊断|IVD|生物信号|放疗|核医学|康复工程)/i;
const PURE_COMPUTING = /(网络安全|前端|后端|软件开发|软件工程|算法工程师|人工智能工程师|AI工程师|大模型|云计算)/i;
const CAMPUS_RECRUITMENT = /(校招|校园招聘|应届|管培|毕业生)/i;
const NON_GRADUATE_RECRUITMENT = /(社招|社会招聘|实习|兼职)/i;
const REQUIRED_EXPERIENCE = /(?:[1-9]\d*\s*年|[一二三四五六七八九十]年)(?:及以上)?(?:工作|相关|从业)经验/i;
const ELIGIBLE_MAJOR_EVIDENCE = /(生物医学工程|医学工程|生物工程|生物技术|医疗器械|医学影像|临床工程|仪器科学|仪器类|工学全类|工学门类|理工类|理工科|所有工学)/i;
const DIRECT_MAJOR_EVIDENCE = /(生物医学工程|医学工程|生物工程|生物技术|医疗器械|医学影像|临床工程|临床医学|基础医学|医学全类|医药卫生|药学)/i;
const BROAD_ENGINEERING_EVIDENCE = /(工学全类|工学门类|理工类|理工科|所有工学)/i;
const TARGET_EMPLOYER_NATURE = /(国企|国有企业|中央企业|事业单位)/;

export class IGuopinDiscoveryError extends Error {
  constructor(message) { super(message); this.name = "IGuopinDiscoveryError"; }
}

function cityFilter(city) {
  const filter = CITY_FILTERS[city];
  if (!filter) throw new IGuopinDiscoveryError(`国聘未登记城市筛选码：${city}`);
  return filter;
}

function today() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function text(value) {
  if (Array.isArray(value)) return value.join("；");
  return String(value || "");
}

function normalizedLocation(values) {
  const unique = [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
  const mostSpecific = unique.filter((value) => !unique.some((candidate) => candidate !== value && candidate.startsWith(value)));
  return mostSpecific.join("；") || "官方未注明";
}

// 国聘的公开接口有时会在投递说明中给出一条外部投递链接；有时则只
// 给出平台内页。只保留平台已经公开提供的链接，不猜测单位官网、更不
// 用搜索结果把线索伪装成官方核验。
function publicApplicationUrl(value) {
  const match = text(value).match(/https?:\/\/[^\s<>"'）)]+/i);
  if (!match) return null;
  try {
    const url = new URL(match[0]);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    if (/^(?:localhost|.+\.local)$/i.test(url.hostname) || /^(?:127\.|0\.0\.0\.0$|::1$)/.test(url.hostname)) return null;
    return url.toString();
  } catch { return null; }
}

function jobBody(job) {
  return [
    job.job_name, job.company_name, job.category_cn, job.education_cn,
    job.experience_cn, text(job.major_cn), job.department_cn,
    job.company_info?.industry_cn, job.contents
  ].filter(Boolean).join(" ");
}

function employerNature(job) {
  return text(job.company_info?.nature_cn || job.company_nature_cn || job.company_type_cn).trim();
}

function classify(job) {
  if (!job?.job_id || job.status !== 1) return { outcome: "not-active" };
  const deadline = String(job.end_time || "").slice(0, 10);
  if (deadline && deadline < today()) return { outcome: "expired" };
  const nature = employerNature(job);
  if (!TARGET_EMPLOYER_NATURE.test(nature)) return { outcome: "employer-nature-mismatch" };
  const recruitmentType = job.nature_cn || job.recruitment_type_cn || "";
  const qualifications = [job.education_cn, job.experience_cn, text(job.major_cn)].filter(Boolean).join(" ");
  const roleText = [job.job_name, job.category_cn, job.department_cn, job.company_info?.industry_cn, job.contents].filter(Boolean).join(" ").replace(/医疗保险|补充医疗|社会保险|五险一金/g, " ");
  if (!mastersEducationEligible(qualifications)) return { outcome: "academic-degree-mismatch" };
  if (NON_GRADUATE_RECRUITMENT.test(recruitmentType) || (recruitmentType && !CAMPUS_RECRUITMENT.test(recruitmentType))) return { outcome: "non-graduate-recruitment" };
  if (REQUIRED_EXPERIENCE.test(String(job.experience_cn || ""))) return { outcome: "experience-mismatch" };
  const professionalEligibility = evaluateProfessionalEligibility(qualifications);
  if (!professionalEligibility.eligible) return { outcome: "no-eligible-major-evidence" };
  if (!roleIsProfileRelevant(roleText)) return { outcome: "pure-computing-role-mismatch" };
  const locations = normalizedLocation((job.district_list || []).map((item) => item.area_cn));
  return {
    outcome: "candidate",
    lead: {
      id: String(job.job_id),
      title: job.job_name || "官方未注明",
      organization: job.company_name || job.company_info?.name || "官方未注明",
      employerNature: nature,
      location: locations,
      education: job.education_cn || "官方未注明",
      majors: text(job.major_cn) || "官方未注明",
      recruitmentType: recruitmentType || "官方未注明",
      publishedAt: String(job.start_time || job.update_time || "").slice(0, 10) || "官方未注明",
      deadline: deadline || "官方未注明",
      officialUrl: `${ORIGIN}/job/detail?id=${encodeURIComponent(job.job_id)}`,
      employerApplyUrl: publicApplicationUrl(job.apply_instruction),
      applicationInstruction: text(job.apply_instruction),
      professionalEligibility,
      evidence: "国聘公开岗位页的城市和专业可报关键词筛选结果；无生物医学交叉场景的纯计算机岗位已排除，平台没有提供单位官方原文时保留为待确认线索。"
    }
  };
}

async function requestPage({ city, keyword, page }, fetchImpl) {
  const response = await fetchImpl(LIST_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0",
      "Device": "h5",
      "Version": "5.2.300",
      "Subsite": "iguopin"
    },
    body: JSON.stringify({
      search: { page, page_size: PAGE_SIZE, keyword, district: [city] },
      recom: { update_time: true, company_nature: true, hot_job: true }
    }),
    signal: AbortSignal.timeout(30_000)
  });
  if (response.url && new URL(response.url).hostname !== "gp-api.iguopin.com") throw new IGuopinDiscoveryError("国聘公开列表请求跳转到未登记域名，已停止采集。");
  const payload = await response.json().catch(() => undefined);
  if (!response.ok || payload?.code !== 200 || !payload?.data) throw new IGuopinDiscoveryError(`国聘公开列表接口未返回成功状态（HTTP ${response.status}）。`);
  return payload.data;
}

export async function collectIGuopinDiscovery({ city, fetchImpl = fetch, maxPagesPerQuery = 20 } = {}) {
  const district = cityFilter(city);
  const raw = new Map();
  const pagesVisited = [];
  const queries = [];
  let portalResultsReported = 0;
  let nativeFilteredResults = 0;
  let truncated = false;
  for (const keyword of KEYWORDS) {
    const first = await requestPage({ city: district, keyword, page: 1 }, fetchImpl);
    const total = Number(first.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const pageLimit = Math.min(totalPages, maxPagesPerQuery);
    portalResultsReported += total;
    nativeFilteredResults += total;
    if (pageLimit < totalPages) truncated = true;
    queries.push({ keyword, total, pagesRead: pageLimit });
    const add = (data) => (data.list || []).forEach((job) => job?.job_id && raw.set(String(job.job_id), job));
    add(first);
    pagesVisited.push(`${ORIGIN}/job/list?${new URLSearchParams({ keyword }).toString()}#district=${district}&page=1`);
    for (let page = 2; page <= pageLimit; page += 1) {
      const following = await requestPage({ city: district, keyword, page }, fetchImpl);
      add(following);
      pagesVisited.push(`${ORIGIN}/job/list?${new URLSearchParams({ keyword }).toString()}#district=${district}&page=${page}`);
    }
  }
  const leads = [];
  const detailOutcomes = {};
  for (const job of raw.values()) {
    const classified = classify(job);
    detailOutcomes[classified.outcome] = (detailOutcomes[classified.outcome] || 0) + 1;
    if (classified.lead) leads.push(classified.lead);
  }
  return {
    sourceId: "iguopin-discovery",
    city,
    collectionMethod: "script",
    collectionRoute: "国聘公开城市＋专业可报关键词并集 → 已筛选分页 → 任职条件专业资格预筛",
    portalResultsReported,
    nativeFilterQueries: KEYWORDS.length,
    nativeFilteredResults,
    deduplicatedCandidates: raw.size,
    detailsChecked: raw.size,
    detailOutcomes,
    leads,
    truncated,
    queries,
    pagesVisited
  };
}

async function main() {
  const cityIndex = process.argv.indexOf("--city");
  const city = cityIndex >= 0 ? process.argv[cityIndex + 1] : "北京";
  console.log(JSON.stringify(await collectIGuopinDiscovery({ city }), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(JSON.stringify({ status: "iguopin-discovery-failed", error: error.message }, null, 2)); process.exitCode = 1; });
}
