const ORIGIN = "https://www.aiball.online";
const API_URL = `${ORIGIN}/api/notices`;
const PAGE_SIZE = 60;
const CITY_FILTERS = { "北京": "北京", "上海": "上海", "广州": "广州", "深圳": "深圳" };
const ALLOWED_ORGANIZATION_TYPES = new Set(["central_soe", "local_soe", "institution", "government"]);
const CLOSED_STATUS = new Set(["closed", "expired"]);

export class AiballDiscoveryError extends Error {
  constructor(message) { super(message); this.name = "AiballDiscoveryError"; }
}

function cityFilter(city) {
  const region = CITY_FILTERS[city];
  if (!region) throw new AiballDiscoveryError(`招录雷达未登记城市筛选值：${city}`);
  return region;
}

function today() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function safeExternalUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hostname === "www.aiball.online") return null;
    return url.toString();
  } catch { return null; }
}

function text(value) {
  return Array.isArray(value) ? value.filter(Boolean).join("；") : String(value || "");
}

function evidenceText(item) {
  return [
    item.title,
    item.decisionNote,
    text(item.eligibilityTags),
    text(item.domainTags),
    ...(Array.isArray(item.evidence) ? item.evidence.flatMap((entry) => [entry?.value, entry?.excerpt]) : [])
  ].filter(Boolean).join(" ");
}

function normalizedLocation(item, city) {
  const values = (item.locationsInScope || [])
    .map((value) => String(value || "").trim())
    .filter((value) => value && !/待附件|待补全|人工确认/.test(value));
  const unique = [...new Set(values)];
  const specific = unique.filter((value) => !unique.some((candidate) => candidate !== value && candidate.startsWith(value)));
  return specific.join("；") || city;
}

function deadlineLabel(item) {
  if (item.applicationEnd) return String(item.applicationEnd).slice(0, 16).replace("T", " ");
  if (item.deadlineKind === "rolling" || item.applicationStatus === "rolling") return "滚动招聘，以官网岗位状态为准";
  return "截止时间以官方原文为准";
}

function employerNatureLabel(type) {
  return ({ central_soe: "中央企业", local_soe: "地方国企", institution: "事业单位", government: "政府机关" })[type] || "单位性质待确认";
}

function classify(item, city, eligibility) {
  if (!item?.id || item.recordRole !== "position") return { outcome: "not-specific-position" };
  if (!ALLOWED_ORGANIZATION_TYPES.has(item.organizationType)) return { outcome: "employer-nature-mismatch" };
  if (CLOSED_STATUS.has(item.applicationStatus) || (item.applicationEnd && String(item.applicationEnd).slice(0, 10) < today())) return { outcome: "expired" };
  if (item.recruitmentType === "internship") return { outcome: "non-graduate-recruitment" };
  const qualifications = evidenceText(item);
  if (!eligibility.mastersEducationEligible(qualifications)) return { outcome: "academic-degree-mismatch" };
  const professionalEligibility = eligibility.evaluateProfessionalEligibility(qualifications);
  if (!professionalEligibility.eligible) return { outcome: "no-eligible-major-evidence" };
  if (!eligibility.roleIsProfileRelevant(`${item.title || ""} ${item.decisionNote || ""} ${text(item.domainTags)}`)) return { outcome: "pure-computing-role-mismatch" };
  const sourceUrl = `${ORIGIN}/notices/${encodeURIComponent(item.id)}`;
  const employerApplyUrl = safeExternalUrl(item.applicationUrl) || safeExternalUrl(item.officialUrl);
  return { outcome: "candidate", lead: {
    id: String(item.id),
    title: item.title || "官方未注明",
    organization: item.organization || "官方未注明",
    employerNature: employerNatureLabel(item.organizationType),
    location: normalizedLocation(item, city),
    education: "硕士报名前请核对官方学历条件",
    majors: professionalEligibility.evidence || professionalEligibility.reason,
    recruitmentType: item.recruitmentType === "campus" ? "校园招聘" : item.recruitmentType || "公开招聘",
    publishedAt: String(item.publishedAt || "").slice(0, 10) || "官方未注明",
    deadline: deadlineLabel(item),
    officialUrl: sourceUrl,
    employerApplyUrl,
    priority: eligibility.rankProfessionalOpportunity(professionalEligibility, `${item.title || ""} ${item.decisionNote || ""}`),
    professionalEligibility,
    evidence: "招录雷达公开地区筛选结果提供了具体岗位、单位性质、专业证据和官方原文链接；本站重新执行国企/事业单位、应届硕士与专业可报筛选，最终条件仍以单位或政府官方页面为准。"
  }};
}

async function requestPage({ region, page }, fetchImpl) {
  const url = new URL(API_URL);
  url.searchParams.set("region", region);
  url.searchParams.set("page", String(page));
  url.searchParams.set("pageSize", String(PAGE_SIZE));
  const response = await fetchImpl(url, {
    headers: { "accept": "application/json", "user-agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(30_000)
  });
  if (response.url && new URL(response.url).hostname !== "www.aiball.online") throw new AiballDiscoveryError("招录雷达公开接口跳转到未登记域名，已停止采集。");
  const payload = await response.json().catch(() => undefined);
  if (!response.ok || !payload || !Array.isArray(payload.items) || !Number.isInteger(payload.total)) {
    throw new AiballDiscoveryError(`招录雷达公开地区筛选接口未返回有效数据（HTTP ${response.status}）。`);
  }
  return { payload, finalUrl: response.url || url.toString() };
}

export async function collectAiballDiscoveryCore({ city, fetchImpl = fetch, maxPages = 20, eligibility } = {}) {
  const region = cityFilter(city);
  if (!eligibility?.evaluateProfessionalEligibility || !eligibility?.rankProfessionalOpportunity) {
    throw new AiballDiscoveryError("招录雷达采集器缺少专业资格判断器。");
  }
  const first = await requestPage({ region, page: 1 }, fetchImpl);
  const totalPages = Math.max(1, Math.ceil(first.payload.total / PAGE_SIZE));
  const pageLimit = Math.min(totalPages, maxPages);
  const raw = new Map();
  const pagesVisited = [];
  const add = ({ payload, finalUrl }) => {
    payload.items.forEach((item) => item?.id && raw.set(String(item.id), item));
    pagesVisited.push(finalUrl);
  };
  add(first);
  for (let page = 2; page <= pageLimit; page += 1) add(await requestPage({ region, page }, fetchImpl));
  const leads = [];
  const detailOutcomes = {};
  for (const item of raw.values()) {
    const result = classify(item, city, eligibility);
    detailOutcomes[result.outcome] = (detailOutcomes[result.outcome] || 0) + 1;
    if (result.lead) leads.push(result.lead);
  }
  return {
    sourceId: "aiball-discovery",
    city,
    collectionMethod: "script",
    collectionRoute: "招录雷达公开地区筛选 API → 该城市全部分页 → 具体岗位与单位性质过滤 → 官方证据中的学历和专业资格预筛",
    portalResultsReported: first.payload.total,
    nativeFilterQueries: 1,
    nativeFilteredResults: first.payload.total,
    deduplicatedCandidates: raw.size,
    detailsChecked: raw.size,
    detailOutcomes,
    leads,
    truncated: pageLimit < totalPages,
    partialReason: pageLimit < totalPages ? `该城市共有 ${totalPages} 页，本轮安全上限为 ${maxPages} 页` : null,
    pagesVisited
  };
}
