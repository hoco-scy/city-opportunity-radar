/**
 * Official-detail extractor and record formatter for China Telecom's public
 * campus list. It only consumes official detail pages obtained after the
 * native city filter has succeeded. It deliberately does not decide whether a
 * role fits a person: that is a batch semantic-review decision made by the
 * scheduled Codex task from the official fields it receives.
 */
import { CollectionSafetyError } from "./collect-chinatelecom.mjs";

const USER_AGENT = "Mozilla/5.0 (compatible; OpportunityRadar/1.0; +https://github.com/hoco-scy/beijing-opportunity-radar)";

function textOf(html = "") {
  return html
    .replace(/&nbsp;/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function contentAfterLabel(html, label) {
  const pattern = new RegExp(`${escapeRegExp(label)}[\\s\\S]{0,120}?<\\/span>\\s*<span[^>]*>([\\s\\S]*?)<\\/span>`, "i");
  const match = html.match(pattern);
  if (!match) return "";
  return match[1].match(/title="([^"]+)"/i)?.[1] || textOf(match[1]);
}

function section(html, label) {
  const pattern = new RegExp(`${escapeRegExp(label)}<\\/div>\\s*<p[^>]*>([\\s\\S]*?)<\\/p>`, "i");
  const match = html.match(pattern);
  return match ? textOf(match[1]) : "";
}

export function positionReference(officialUrl) {
  try { return new URL(officialUrl).searchParams.get("postIdEnc") || "官网未提供职位代码"; } catch { return "官网未提供职位代码"; }
}

export function parseChinaTelecomDetail(html, fallback = {}) {
  if (/\/(?:404|error)(?:[/?#]|$)|页面不存在|not\s+found/i.test(html.slice(0, 12000))) {
    throw new CollectionSafetyError("官方职位详情落入语义错误页。");
  }
  const titleMatch = html.match(/<div\s+class="position_title"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i);
  const title = textOf(titleMatch?.[1] || fallback.title);
  const responsibilities = section(html, "工作内容/职位描述：");
  const requirements = section(html, "任职要求：");
  if (!title || (!responsibilities && !requirements)) {
    throw new CollectionSafetyError("官方职位详情缺少职位名称或职位说明，不能形成审核结论。");
  }
  return {
    ...fallback,
    title,
    organization: contentAfterLabel(html, "所属公司：") || fallback.organization || "官方未注明",
    department: contentAfterLabel(html, "所属部门：") || "官方未注明",
    location: contentAfterLabel(html, "工作地点：") || fallback.location || "官方未注明",
    headcount: contentAfterLabel(html, "招聘人数：") || fallback.headcount || "官方未注明",
    education: contentAfterLabel(html, "学&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;历：") || fallback.education || "官方未注明",
    publishedAt: contentAfterLabel(html, "发布时间：") || fallback.publishedAt || "官网未注明",
    responsibilities,
    requirements,
    hasApplyControl: /立即申请/.test(html),
    positionRef: positionReference(fallback.officialUrl)
  };
}

async function fetchDetailPage(officialUrl, fetchImpl) {
  const response = await fetchImpl(officialUrl, {
    redirect: "follow",
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml", "accept-language": "zh-CN,zh;q=0.9" },
    signal: AbortSignal.timeout(30_000)
  });
  const html = await response.text();
  if (!response.ok) throw new CollectionSafetyError(`官方职位详情请求失败：HTTP ${response.status}。`);
  if (!response.url.startsWith("https://job.chinatelecom.com.cn/")) throw new CollectionSafetyError("官方职位详情跳转到非登记域名，拒绝处理。");
  return html;
}

export async function fetchChinaTelecomDetails(positions, { concurrency = 3, fetchImpl = fetch } = {}) {
  const details = new Array(positions.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < positions.length) {
      const index = nextIndex++;
      const candidate = positions[index];
      try {
        details[index] = parseChinaTelecomDetail(await fetchDetailPage(candidate.officialUrl, fetchImpl), candidate);
      } catch (error) {
        details[index] = { ...candidate, positionRef: positionReference(candidate.officialUrl), detailError: error.message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), positions.length) }, worker));
  return details;
}

function reviewId(checkedAt, detail) {
  return `review-${checkedAt.slice(0, 10).replaceAll("-", "")}-${checkedAt.slice(11, 16).replace(":", "")}-${positionReference(detail.officialUrl).replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}`;
}

export function reviewRecord(detail, result, { checkedAt, sourceId }) {
  return {
    id: reviewId(checkedAt, detail), scope: "position", track: "央国企",
    organization: detail.organization || "官方未注明", title: detail.title || "官网职位详情待确认",
    officialPublishedAt: detail.publishedAt || "官网未注明", headcount: detail.headcount || "官方未注明",
    deadline: "官网未单列；以招聘系统实时状态为准", decision: result.decision, reasonCode: result.reasonCode,
    reason: result.reason, semanticBasis: result.semanticBasis,
    verificationNote: detail.detailError || "已从官网职位详情核对单位、地点、学历、职责、任职要求和投递入口。",
    fallback: "打开中国电信官网职位详情，查看完整要求并从官网投递。", sourceId, officialUrl: detail.officialUrl
  };
}

export function publishableJob(detail, { checkedAt, city, source, decision }) {
  const positionRef = positionReference(detail.officialUrl);
  return {
    id: `chinatelecom-${positionRef}`, track: "央国企", subtrack: "通信央企", organization: detail.organization,
    department: detail.department || "官方未注明", title: detail.title, exactTitle: detail.title, jobCode: positionRef,
    location: detail.location, cohort: "校园招聘", recruitmentType: "校园招聘", headcount: detail.headcount,
    education: detail.education, degree: "官方未单列", majors: detail.requirements, politicalStatus: "官方未单列",
    experience: "校园招聘岗位", responsibilities: [detail.responsibilities], requirements: [detail.requirements],
    publishedAt: detail.publishedAt, deadline: "官网未单列；以招聘系统实时状态为准", deadlineType: "官方未单列",
    status: "招聘中", priority: decision.priority, matchLevel: decision.matchLevel,
    matchReason: decision.matchReason,
    riskNotes: ["官网职位页未单列报名截止日，投递前请以系统实时状态为准。"],
    tags: [city, "中国电信", "校园招聘", ...(decision.tags || [])], sourceId: source.id,
    officialAnnouncementUrl: source.entryUrl, officialApplyUrl: detail.officialUrl,
    applyInstruction: "打开中国电信官网职位详情后点击“立即申请”。", verifiedAt: checkedAt.slice(0, 10),
    lastSeenAt: checkedAt, lastSeenStatus: "live", statusEvidence: "本轮已在中国电信官网职位详情核验岗位字段和“立即申请”入口。",
    verifiedFields: ["单位", "岗位名称", "地点", "学历", "职责", "任职要求", "投递路径"],
    verification: { officialSource: true, specificPosition: true, location: true, eligibility: true, applicationPath: true, deadlineChecked: true }
  };
}
