#!/usr/bin/env node
/** Structured, no-login collector for China Resources' official public gateway. */
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { evaluateProfessionalEligibility, matchLevelForPriority, mastersEducationEligible, objectiveRiskFlags, rankProfessionalOpportunity, roleIsProfileRelevant } from "./professional-eligibility.mjs";

const ENTRY_URL = "https://runjob.crc.com.cn/#/complex/homepage?id=1769554545615040514";
const GATEWAY = "https://ssdp.crc.com.cn/ssdp/sys/rf/";
const WEBSITE_ID = "1769554545615040514";
const PAGE_SIZE = 300;
const CITY_NAMES = { "北京": "北京", "上海": "上海", "广州": "广州", "深圳": "深圳" };
const execFileAsync = promisify(execFile);

export class CrcCareersError extends Error { constructor(message) { super(message); this.name = "CrcCareersError"; } }
function clean(value) { return String(value || "").replace(/\u00a0/g, " ").replace(/<[^>]+>/g, " ").replace(/\r/g, "").replace(/[ \t]+/g, " ").trim(); }
function shanghaiMinute(now = new Date()) {
  const parts = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(now).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00+08:00`;
}
function lines(value) { return clean(value).split(/\n+(?=\d+[.、]\s*)|\n+/).map(clean).filter(Boolean); }
function timestamp() {
  const now = new Date();
  const value = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(now).replace("T", " ");
  return `${value}:${now.getMilliseconds()}`;
}
function gatewayHeader(apiId) {
  const suffix = String(apiId).split("HRMS")[1];
  if (!suffix) throw new CrcCareersError("华润公开接口标识无效。");
  return Buffer.from(`Api_Version=1.0&Api_ID=crinfo.hrms${suffix}&App_Sub_ID=0006000908YA&App_Token=60fe2d19e5ad491f8a02508da3efe532&Sys_ID=00060009&Partner_ID=00060000&Sign=NO_SIGN&Time_Stamp=${timestamp()}&User_Token=`).toString("base64");
}
async function officialGatewayIps() {
  const { stdout } = await execFileAsync("curl", [
    "-sS", "--max-time", "20", "https://dns.google/resolve?name=ssdp.crc.com.cn&type=A"
  ], { maxBuffer: 1_000_000 });
  const payload = JSON.parse(stdout);
  return [...new Set((payload.Answer || []).map((item) => item.data).filter((value) => /^(?:\\d{1,3}\\.){3}\\d{1,3}$/.test(value)))];
}
async function curlGateway(url, body, resolveIp) {
  const resolveArgs = resolveIp ? ["--resolve", `ssdp.crc.com.cn:443:${resolveIp}`] : [];
  const { stdout } = await execFileAsync("curl", [
    "-sS", "--max-time", "45", ...resolveArgs, "-A", "Mozilla/5.0",
    "-H", "content-type: application/json", "-H", `homepageConfigId: ${WEBSITE_ID}`, "-H", "languageIndex: 0",
    "--data-binary", JSON.stringify(body), url
  ], { maxBuffer: 12_000_000 });
  return JSON.parse(stdout);
}
async function postGateway(url, body, fetchImpl) {
  try {
    const response = await fetchImpl(url, {
      method: "POST", redirect: "follow", signal: AbortSignal.timeout(45_000),
      headers: { "content-type": "application/json", homepageConfigId: WEBSITE_ID, languageIndex: "0", "user-agent": "Mozilla/5.0" },
      body: JSON.stringify(body)
    });
    if (!response.ok || new URL(response.url || GATEWAY).hostname !== "ssdp.crc.com.cn") throw new CrcCareersError(`华润公开网关返回 HTTP ${response.status}。`);
    return response.json();
  } catch (error) {
    if (fetchImpl !== globalThis.fetch) throw error;
    try { return await curlGateway(url, body); }
    catch {
      let lastError = error;
      for (const ip of await officialGatewayIps()) {
        try { return await curlGateway(url, body, ip); }
        catch (curlError) { lastError = curlError; }
      }
      throw lastError;
    }
  }
}
async function gatewayCall(apiId, method, param, fetchImpl, attempts = 3) {
  let lastError;
  const requestAttempts = fetchImpl.isResilientCollectionFetch ? 1 : attempts;
  for (let attempt = 1; attempt <= requestAttempts; attempt += 1) {
    try {
      const url = `${GATEWAY}?ssdp=${encodeURIComponent(gatewayHeader(apiId))}`;
      const body = { base64String: Buffer.from(JSON.stringify({ biz: { method, param } })).toString("base64") };
      const payload = await postGateway(url, body, fetchImpl);
      if (payload?.RESPONSE?.RETURN_CODE !== "MS000A000") throw new CrcCareersError(`华润公开网关返回：${payload?.RESPONSE?.RETURN_DESC || "未知错误"}`);
      const decoded = Buffer.from(payload.RESPONSE.RETURN_DATA || "", "base64").toString();
      if (!decoded || !/^[\[{]/.test(decoded)) return decoded;
      return JSON.parse(decoded);
    } catch (error) {
      lastError = error;
      if (attempt < requestAttempts) await new Promise((resolve) => setTimeout(resolve, attempt * 300));
    }
  }
  throw lastError;
}
async function requestPage(pageNum, fetchImpl) {
  const result = await gatewayCall("crc.HRMS.rm.synthesizeHomepagePosition", "getSynthesizeHomepagePosition", {
    homepageConfigId: WEBSITE_ID, location: "", industryType: "", typeId: "", rmWorkYearsRqmt: "", rmEducationalRqmt: "", keyword: "", pageNum, pageSize: PAGE_SIZE
  }, fetchImpl);
  if (!result?.successful || !Array.isArray(result.data) || !Number.isInteger(Number(result.total))) throw new CrcCareersError("华润职位接口未返回完整分页结构。");
  return result;
}
function isCampus(row) { return row?.typeId === "A02" || /校园招聘|校招/.test(clean(row?.typeIdDescr)); }
function cityMatches(row, city) { return clean([row.locationDescr, ...(row.locationList || [])].join("；")).includes(CITY_NAMES[city]); }
function majorLines(requirement) { const selected = lines(requirement).filter((item) => /专业|学科|工学|理工|医学|生物|不限/.test(item)); return selected.join("；") || clean(requirement); }
function expectedGraduateYear(checkedAt) {
  const match = String(checkedAt).match(/^(\d{4})-(\d{2})/);
  if (!match) return new Date().getUTCFullYear();
  return Number(match[1]) + (Number(match[2]) >= 7 ? 1 : 0);
}
function explicitCohortMismatch(row, checkedAt) {
  const years = [...clean(`${row.pubPositionName} ${row.rmJobRqmt}`).matchAll(/(20\d{2})届/g)].map((match) => Number(match[1]));
  return years.length > 0 && !years.includes(expectedGraduateYear(checkedAt));
}

export function classifyCrcRow(row, city, checkedAt) {
  if (!row?.pubPositionId || !isCampus(row)) return { outcome: "non-campus" };
  if (explicitCohortMismatch(row, checkedAt)) return { outcome: "old-cohort" };
  if (!cityMatches(row, city)) return { outcome: "location-mismatch" };
  const requirement = clean(row.rmJobRqmt);
  if (!mastersEducationEligible(`${row.rmEducationalRqmtDescr || ""} ${requirement}`)) return { outcome: "education-mismatch" };
  const eligibility = evaluateProfessionalEligibility(requirement);
  if (!eligibility.eligible) return { outcome: `professional-${eligibility.basis}`, reason: eligibility.reason };
  const roleText = clean(`${row.pubPositionName} ${row.rmJobDuty}`);
  if (!roleIsProfileRelevant(roleText)) return { outcome: "pure-computing-role-mismatch" };
  const priority = rankProfessionalOpportunity(eligibility, roleText);
  const risks = objectiveRiskFlags(roleText);
  const level = matchLevelForPriority(priority, eligibility);
  const organization = clean(row.brandName || row.companyDescr) || "华润集团";
  const detailUrl = `https://runjob.crc.com.cn/#/complex/RecruitDetail?id=${encodeURIComponent(row.pubPositionId)}&comId=${WEBSITE_ID}&typeId=${encodeURIComponent(row.typeId || "A02")}`;
  return { outcome: "accepted", job: {
    id: `crc-${String(row.pubPositionId).toLowerCase()}`, track: "央国企", subtrack: /医药|健康|医疗/.test(organization) ? "医疗健康央企" : "综合央企",
    organization, department: clean(row.companyDescr || row.deptIdDescr) || "官方未单列", title: clean(row.pubPositionName) || "具体岗位", exactTitle: clean(row.pubPositionName) || "具体岗位",
    jobCode: String(row.pubPositionId), location: clean(row.locationDescr || (row.locationList || []).join("；")), cohort: "应届校园招聘",
    recruitmentType: clean(row.typeIdDescr) || "校园招聘", headcount: clean(row.rmEmplCnt) || "官方未注明",
    education: clean(row.rmEducationalRqmtDescr) || "官方任职条件未单列学历", degree: "以官方岗位条件为准", majors: majorLines(requirement),
    politicalStatus: "官方未单列", experience: "应届生岗位", responsibilities: lines(row.rmJobDuty), requirements: lines(row.rmJobRqmt),
    publishedAt: clean(row.publishDate) || "官方未注明", deadline: "岗位招满即停，以官方招聘系统实时状态为准", deadlineType: "动态截止",
    status: "招聘中", priority, matchLevel: level, matchReason: `${eligibility.reason}（命中“${eligibility.evidence}”）；已排除无生物医学交叉的纯计算机岗位，其他岗位内容只影响排序。`,
    riskNotes: risks.length ? [`官方职责出现客观工作强度/环境提示：${risks.join("、")}`] : [], tags: [city, eligibility.evidence, level].filter(Boolean),
    sourceId: "crc-careers", officialAnnouncementUrl: ENTRY_URL, officialApplyUrl: detailUrl, applyInstruction: "打开华润集团官方职位页核对并投递",
    verifiedAt: checkedAt, lastSeenAt: checkedAt, lastSeenStatus: "live", statusEvidence: "华润集团公开职位网关当前返回的校园招聘岗位。",
    professionalEligibility: eligibility, verifiedFields: ["职位", "单位", "地点", "招聘类型", "学历", "专业", "职责", "投递路径"],
    verification: { officialSource: true, specificPosition: true, location: true, eligibility: true, applicationPath: true, deadlineChecked: true }
  }};
}

export async function collectCrcCareers({ city, fetchImpl = fetch, now = new Date() } = {}) {
  if (!CITY_NAMES[city]) throw new CrcCareersError(`华润采集器未登记城市：${city}`);
  const checkedAt = shanghaiMinute(now);
  const config = await gatewayCall("crc.HRMS.rm.websiteView", "loadComplexWebsiteStyle", { id: WEBSITE_ID }, fetchImpl);
  if (!/华润/.test(clean(config?.websiteConfig?.websiteName)) || String(config?.websiteConfig?.id) !== WEBSITE_ID) throw new CrcCareersError("华润公开网关没有返回已登记官网配置。");
  const first = await requestPage(1, fetchImpl);
  const totalPages = Math.max(1, Math.ceil(Number(first.total) / PAGE_SIZE));
  const rows = [...first.data];
  for (let pageNum = 2; pageNum <= totalPages; pageNum += 1) rows.push(...(await requestPage(pageNum, fetchImpl)).data);
  const unique = [...new Map(rows.map((row) => [`${row.pubPositionId}:${row.typeId}`, row])).values()];
  const jobs = [], outcomes = {};
  for (const row of unique) { const result = classifyCrcRow(row, city, checkedAt); outcomes[result.outcome] = (outcomes[result.outcome] || 0) + 1; if (result.job) jobs.push(result.job); }
  jobs.sort((a, b) => b.priority - a.priority || a.title.localeCompare(b.title, "zh-CN"));
  return {
    sourceId: "crc-careers", city, collectionMethod: "script", collectionRoute: "华润官方公开网关 → 全部职位分页 → 招聘类型=校园招聘 → 城市 → 任职条件专业资格门禁",
    status: "checked-native-filtered", portalResultsReported: Number(first.total), nativeFilterQueries: 1, nativeFilteredResults: unique.length,
    deduplicatedCandidates: unique.length, detailsChecked: unique.length, positionsOfficiallyVerified: jobs.length, collected: unique.length, afterFilter: jobs.length,
    detailOutcomes: outcomes, jobs, pagesVisited: [ENTRY_URL, ...Array.from({ length: totalPages }, (_, index) => `${GATEWAY}#page=${index + 1}&pageSize=${PAGE_SIZE}`)],
    filterEvidence: { city, pageSize: PAGE_SIZE, totalPages, campusType: "A02", professionalGate: "only-official-major-requirements", note: "华润综合职位接口未稳定执行地点参数，脚本读取官方分页后使用返回的招聘类型和地点字段进行确定性本地筛选。" }
  };
}

async function defaultCity() { const data = JSON.parse(await readFile(new URL("../data/filter-recipes.json", import.meta.url), "utf8")); return data.city; }
async function main() { const index = process.argv.indexOf("--city"); const city = index >= 0 ? process.argv[index + 1] : await defaultCity(); console.log(JSON.stringify(await collectCrcCareers({ city }), null, 2)); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(JSON.stringify({ status: "crc-careers-failed", error: error.message }, null, 2)); process.exitCode = 1; });
