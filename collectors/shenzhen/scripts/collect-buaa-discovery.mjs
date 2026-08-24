#!/usr/bin/env node
/**
 * Read the public, no-login recruitment search exposed by 北航就业信息网.
 *
 * This collector is deliberately a discovery collector: it uses the site's
 * own city and unit-nature filters, reads only the resulting pages,
 * and returns leads for an employer/government-source verification step. It
 * never writes opportunities and never treats a university repost as final
 * publication evidence.
 */
import { pathToFileURL } from "node:url";
import { evaluateProfessionalEligibility, mastersEducationEligible, roleIsProfileRelevant } from "./professional-eligibility.mjs";

const ORIGIN = "https://career.buaa.edu.cn";
const CONFIG_URL = `${ORIGIN}/frontpage/buaa/js/init.js`;
const LIST_URL = `${ORIGIN}/f/recruitmentinfo/ajax_frontRecruitinfo`;
const DETAIL_URL = `${ORIGIN}/f/recruitmentinfo/ajax_show`;
const CITY_CODES = { "北京": "110000", "上海": "310000", "广州": "440100", "深圳": "440300" };
const UNIT_NATURES = ["31", "23", "20"]; // 国企、医疗卫生单位、科研设计单位
const BIOMEDICAL_CONTEXT = /(生物医学|医疗器械|医学影像|临床工程|体外诊断|IVD|生物信号|医疗|健康|生物工程|生命科学)/i;
const ENGINEERING_QUALIFICATION = /(生物医学工程|医疗器械|医学影像|生物工程|临床工程|仪器|电子|自动化|工学|理工)/i;
const DIRECT_BIOMEDICAL_BRIDGE = /(生物医学工程|医疗器械|医学影像|临床工程|体外诊断|IVD|生物信号|放疗|核医学|康复工程)/i;
const PURE_COMPUTING = /(网络安全|前端|后端|软件开发|软件工程|算法工程师|人工智能工程师|AI工程师|大模型|云计算)/i;
const ELIGIBLE_MAJOR_EVIDENCE = /(生物医学工程|医学工程|生物工程|生物技术|医疗器械|医学影像|临床工程|仪器科学|仪器类|工学全类|工学门类|理工类|理工科|所有工学)/i;

export class BuaaDiscoveryError extends Error {
  constructor(message) { super(message); this.name = "BuaaDiscoveryError"; }
}

function cityCode(city) {
  const code = CITY_CODES[city];
  if (!code) throw new BuaaDiscoveryError(`北航就业网未登记城市筛选代码：${city}`);
  return code;
}

function minuteNow(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function textFromHtml(value = "") {
  return String(value).replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

function officialUrl(path) {
  const url = new URL(path, ORIGIN);
  if (url.hostname !== "career.buaa.edu.cn") throw new BuaaDiscoveryError("北航公开接口跳转到未登记域名，已停止采集。");
  return url.toString();
}

function normalizedLocation(values, fallback) {
  const unique = [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
  const mostSpecific = unique.filter((value) => !unique.some((candidate) => candidate !== value && candidate.startsWith(value)));
  return mostSpecific.join("；") || fallback || "官方未注明";
}

async function publicToken(fetchImpl) {
  const response = await fetchImpl(CONFIG_URL, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30_000) });
  const script = await response.text();
  if (!response.ok || response.url && new URL(response.url).hostname !== "career.buaa.edu.cn") throw new BuaaDiscoveryError("北航公开前端配置不可用。");
  const token = script.match(/\btoken\s*:\s*["']([^"']+)["']/)?.[1];
  if (!token) throw new BuaaDiscoveryError("北航公开前端未提供列表所需的公开令牌；不会猜测或绕过访问控制。");
  return { token, configUrl: response.url || CONFIG_URL };
}

async function formJson(url, fields, token, fetchImpl) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "user-agent": "Mozilla/5.0", "content-type": "application/x-www-form-urlencoded", token },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(30_000)
  });
  if (response.url && new URL(response.url).hostname !== "career.buaa.edu.cn") throw new BuaaDiscoveryError("北航公开请求跳转到未登记域名，已停止采集。");
  const data = await response.json().catch(() => undefined);
  if (!response.ok || data?.state !== 1) throw new BuaaDiscoveryError(`北航公开筛选接口未返回成功状态（HTTP ${response.status}）。`);
  return { data, finalUrl: response.url || url };
}

function classifyDetail(detail, listItem, city) {
  const info = detail?.object?.recruitmentinfo;
  if (!info?.id || info.isFrontShow === "0") return { outcome: "not-public" };
  const positions = Array.isArray(info.recruitmentPositionList) ? info.recruitmentPositionList : [];
  const location = normalizedLocation(positions.map((item) => item.cityName), info.corporationinfo?.areaName || info.corporationArea);
  const qualifications = [info.majorName, info.education, ...positions.map((item) => item.majorName), ...positions.map((item) => item.studentType)].filter(Boolean).join("；");
  const roleText = [info.title, info.corporationName, ...positions.map((item) => item.positionName), ...positions.map((item) => item.positionDescription)].filter(Boolean).join(" ");
  const end = String(info.endTime || "").slice(0, 10);
  if (end && end < minuteNow()) return { outcome: "expired" };
  if (!mastersEducationEligible(qualifications)) return { outcome: "academic-degree-mismatch" };
  const professionalEligibility = evaluateProfessionalEligibility(qualifications);
  if (!professionalEligibility.eligible) return { outcome: "no-eligible-major-evidence" };
  if (!roleIsProfileRelevant(roleText)) return { outcome: "pure-computing-role-mismatch" };
  const employerUrl = String(info.onlineApplicationUrl || "").trim();
  return { outcome: "candidate", lead: {
    id: info.id,
    title: info.title || listItem.title || "官方未注明",
    organization: info.corporationName || info.corporationinfo?.name || "官方未注明",
    location,
    education: info.education || "官方未注明",
    majors: qualifications || "官方未注明",
    publishedAt: String(info.startTime || listItem.startTime || "").slice(0, 10) || "官方未注明",
    deadline: end || "官方未注明",
    officialUrl: officialUrl(`/frontpage/buaa/html/recruitmentinfoForm.html?positionDetailId=${encodeURIComponent(info.id)}`),
    employerApplyUrl: /^https?:\/\//i.test(employerUrl) ? employerUrl : null,
    professionalEligibility,
    evidence: "北航就业信息网的城市、单位性质筛选结果；已核对公开专业条件，并排除无生物医学交叉场景的纯计算机岗位，仍须回溯单位或政府官方页面。"
  }};
}

export async function collectBuaaDiscovery({ city, fetchImpl = fetch, maxPagesPerQuery = 12 } = {}) {
  const code = cityCode(city);
  const { token, configUrl } = await publicToken(fetchImpl);
  const raw = new Map();
  const pagesVisited = [configUrl];
  let portalResultsReported = 0;
  let nativeFilteredResults = 0;
  let nativeFilterQueries = 0;
  let truncated = false;
  for (const corporationNature of UNIT_NATURES) {
    nativeFilterQueries += 1;
    const first = await formJson(LIST_URL, { pageNo: "1", pageSize: "100", positionType: "1", city: code, corporationNature, "corporationinfo.industry": "" }, token, fetchImpl);
    const page = first.data.object || {};
    const totalPages = Number(page.totalPage || 1);
    if (!Number.isInteger(totalPages) || totalPages < 1) throw new BuaaDiscoveryError("北航筛选结果未返回有效分页信息。");
    portalResultsReported += Number(page.count || 0);
    nativeFilteredResults += Number(page.count || 0);
    const pageLimit = Math.min(totalPages, maxPagesPerQuery);
    if (pageLimit < totalPages) truncated = true;
    const collect = (result) => (result.data.object?.list || []).forEach((item) => item?.id && raw.set(item.id, item));
    collect(first);
    pagesVisited.push(`${first.finalUrl}#${new URLSearchParams({ city: code, corporationNature }).toString()}&page=1`);
    for (let pageNo = 2; pageNo <= pageLimit; pageNo += 1) {
      const following = await formJson(LIST_URL, { pageNo: String(pageNo), pageSize: "100", positionType: "1", city: code, corporationNature, "corporationinfo.industry": "" }, token, fetchImpl);
      collect(following);
      pagesVisited.push(`${following.finalUrl}#${new URLSearchParams({ city: code, corporationNature }).toString()}&page=${pageNo}`);
    }
  }
  const leads = [];
  const detailOutcomes = {};
  let detailsChecked = 0;
  for (const item of raw.values()) {
    const result = await formJson(DETAIL_URL, { recruitmentId: item.id }, token, fetchImpl);
    detailsChecked += 1;
    const classified = classifyDetail(result.data, item, city);
    detailOutcomes[classified.outcome] = (detailOutcomes[classified.outcome] || 0) + 1;
    if (classified.lead) leads.push(classified.lead);
  }
  return {
    sourceId: "buaa-career-discovery", city, collectionMethod: "script", collectionRoute: "北航就业信息网公开城市＋单位性质筛选 → 已筛选分页 → 公开岗位详情 → 任职条件专业资格预筛",
    portalResultsReported, nativeFilterQueries, nativeFilteredResults, deduplicatedCandidates: raw.size,
    detailsChecked, detailOutcomes, leads, truncated, pagesVisited
  };
}

async function main() {
  const cityIndex = process.argv.indexOf("--city");
  const city = cityIndex >= 0 ? process.argv[cityIndex + 1] : "北京";
  const result = await collectBuaaDiscovery({ city });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(JSON.stringify({ status: "buaa-discovery-failed", error: error.message }, null, 2)); process.exitCode = 1; });
}
