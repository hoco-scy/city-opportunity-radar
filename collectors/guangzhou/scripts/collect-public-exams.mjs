#!/usr/bin/env node
/**
 * Read-only collectors for the official national, Beijing, Shanghai and
 * Guangdong civil-service examination notice systems.
 *
 * The script deliberately produces a collection manifest rather than changing
 * opportunities.json or review-log.json.  It is safe to run in a fresh cloud
 * container after `npm ci`: no browser profile, cookie, login, or local state
 * is needed.  A snapshot is written only when `--snapshot <path>` is supplied.
 *
 * Examples
 *   node scripts/collect-public-exams.mjs --source national-civil --summary
 *   node scripts/collect-public-exams.mjs --source beijing-civil --parse-position-tables
 *   node scripts/collect-public-exams.mjs --source guangzhou-civil --parse-position-tables --summary
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import AdmZip from "adm-zip";
import * as XLSX from "xlsx";

const USER_AGENT = "Mozilla/5.0 (compatible; OpportunityRadar/1.0; +https://github.com/hoco-scy/beijing-opportunity-radar)";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024;
const MAX_WORKBOOK_BYTES = 20 * 1024 * 1024;

const SOURCE_CONFIG = {
  "national-civil": {
    sourceId: "national-civil",
    label: "国家公务员局",
    allowedDomains: ["scs.gov.cn"],
    allowHttp: true,
    entries: [
      { role: "主入口", url: "http://bm.scs.gov.cn/pp/gkweb/core/web/ui/business/home/gkhome.html" },
      { role: "补充录用入口", url: "http://subb.scs.gov.cn/pp/gkweb/core/web/ui/business/home/lxhome.html" }
    ]
  },
  "beijing-civil": {
    sourceId: "beijing-civil",
    label: "北京市公务员招考主管部门",
    allowedDomains: ["beijing.gov.cn"],
    entries: [{ role: "公告列表", url: "https://www.beijing.gov.cn/gongkai/rsxx/gwyzk/" }],
    defaultCity: "北京市"
  },
  "beijing-selection-program": {
    sourceId: "beijing-selection-program",
    label: "北京市人力资源和社会保障局选调优培公告",
    allowedDomains: ["rsj.beijing.gov.cn"],
    detailTitleDiscovery: true,
    detailExtFallback: true,
    entries: [{ role: "选调优培公告列表", url: "https://rsj.beijing.gov.cn/xxgk/tzgg/" }],
    defaultCity: "北京市"
  },
  "shanghai-civil": {
    sourceId: "shanghai-civil",
    label: "上海市公务员局",
    allowedDomains: ["shacs.gov.cn"],
    entries: [{ role: "公告专题", url: "https://shacs.gov.cn/" }],
    defaultCity: "上海市"
  },
  "shanghai-selection-program": {
    sourceId: "shanghai-selection-program",
    label: "上海市公务员局选调生专题",
    allowedDomains: ["shacs.gov.cn"],
    entries: [{ role: "选调生官方专题", url: "https://www.shacs.gov.cn/" }],
    defaultCity: "上海市"
  },
  "guangzhou-civil": {
    sourceId: "guangzhou-civil",
    label: "广东省公务员主管部门（广州职位）",
    allowedDomains: ["gdzz.gov.cn", "ggfw.hrss.gd.gov.cn"],
    entries: [
      { role: "公务员录用与培育通知", url: "https://www.gdzz.gov.cn/gwygz/lypytzgg/index.html" },
      { role: "报名系统公告", url: "https://ggfw.hrss.gd.gov.cn/gwyks/anouns.do" }
    ],
    defaultCity: "广州市"
  },
  "shenzhen-civil": {
    sourceId: "shenzhen-civil",
    label: "广东省公务员主管部门（深圳职位）",
    allowedDomains: ["gdzz.gov.cn", "ggfw.hrss.gd.gov.cn"],
    entries: [
      { role: "公务员录用与培育通知", url: "https://www.gdzz.gov.cn/gwygz/lypytzgg/index.html" },
      { role: "报名系统公告", url: "https://ggfw.hrss.gd.gov.cn/gwyks/anouns.do" }
    ],
    defaultCity: "深圳市"
  },
  "guangzhou-selection-program": {
    sourceId: "guangzhou-selection-program",
    label: "广东省应届选调生公告（选调高校公开发布，广州岗位）",
    allowedDomains: ["career.buaa.edu.cn"],
    buaaSelection: {
      titlePattern: /广东省.*(?:定向)?选调.*(?:应届)?(?:优秀)?(?:大学|高校)毕业生.*公告/,
      issuerPattern: /(?:中共)?广东省委组织部/
    },
    categoryApiUrl: "https://career.buaa.edu.cn/f/newsCenter/ajax_list",
    clientConfigUrl: "https://career.buaa.edu.cn/frontpage/buaa/js/init.js",
    detailApiUrl: "https://career.buaa.edu.cn/f/newsCenter/ajax_view",
    categoryId: "5453aeeb99e74d78aea0b45fd456ae68",
    entries: [{ role: "选调高校官方就业网：公务员／选调生", url: "https://career.buaa.edu.cn/frontpage/buaa/html/newsList.html?id=5453aeeb99e74d78aea0b45fd456ae68" }],
    defaultCity: "广州市"
  },
  "shenzhen-selection-program": {
    sourceId: "shenzhen-selection-program",
    label: "中共深圳市委组织部选调优培公告",
    allowedDomains: ["www.zzb.sz.gov.cn"],
    allowHttp: true,
    detailTitleDiscovery: true,
    dataApiUrl: "http://www.zzb.sz.gov.cn/postmeta/i/29672.json",
    entries: [{ role: "组织部公告列表", url: "http://www.zzb.sz.gov.cn/notice/announcement/" }],
    defaultCity: "深圳市"
  }
};

const NOTICE_PATTERN = /(考试录用.{0,12}公务员|公务员.{0,24}(公告|职位|招考|补充录用|调剂|遴选|选调)|选调(?:应届)?优秀(?:大学|高校)毕业生|定向选调|公开选调(?:公务员)?|选调生|优培)/;
const POSITION_ATTACHMENT_PATTERN = /(职位|招考简章|职位查询|附件\s*[一1]|附件1[-—至]?[\d一二三四五六七八九十]*)/;
const POSITION_TABLE_FILE_PATTERN = /\.(?:xlsx?|csv|zip)(?:$|[?#])/i;
const FILE_ATTACHMENT_PATTERN = /\.(?:zip|xls|xlsx|csv|pdf|doc|docx)(?:$|[?#])/i;

export class CollectionSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = "CollectionSafetyError";
  }
}

function decodeHtml(value = "") {
  return String(value)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

export function textFromHtml(html = "") {
  return decodeHtml(String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " "));
}

function parseOfficialDate(value) {
  const match = String(value).match(/(20\d{2})[年./-](\d{1,2})[月./-](\d{1,2})/);
  if (!match) return undefined;
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

/**
 * Returns only public deadline evidence. It deliberately treats missing or
 * ambiguous date wording as unknown, never as an open campaign.
 */
export function extractApplicationLifecycle(html = "", now = new Date(), context = {}) {
  // Government CMS pages commonly put individual digits in nested spans.  Do
  // not insert spaces between inline tags here, otherwise `2026年5月8日` turns
  // into `202 6 年 5 月 8 日` and an already-closed campaign looks unknown.
  const text = decodeHtml(String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/?(?:span|strong|b|em|font|i|u)\b[^>]*>/gi, "")
    .replace(/<\/?(?:p|div|li|tr|br|h[1-6])\b[^>]*>/gi, "。")
    .replace(/<[^>]*>/g, " "));
  const passages = text.split(/[。；\n]/).filter((passage) => /(报名|报考|职位填报|填报职位|申请调剂)/.test(passage));
  const fallbackYear = Number(String(context.title || "").match(/(20\d{2})年度/)?.[1]
    || String(context.publishedAt || "").match(/(20\d{2})/)?.[1]) || undefined;
  const registrationWindows = [];
  for (const passage of passages) {
    // Do not use a later graduation, age or credential deadline merely because
    // it shares a paragraph with the registration instructions.  A window is
    // anchored to the first two dates immediately following a registration
    // phrase (the usual start/end pair in official Chinese notices).
    const matcher = /(?:网上)?(?:报名|报考)(?:时间|期间)?(?!系统|者|条件|资格|职位|指南|表|确认|技术|咨询)/g;
    for (const match of passage.matchAll(matcher)) {
      const fragment = passage.slice(match.index, match.index + 120);
      const dateMatches = [...fragment.matchAll(/(?:(20\d{2})年)?(?:(\d{1,2})月)?(\d{1,2})日/g)].slice(0, 2);
      if (dateMatches.length) registrationWindows.push({ passage, dateMatches });
    }
  }
  const dates = [...new Set(registrationWindows.flatMap(({ dateMatches }) => {
    let year = fallbackYear;
    let month;
    const found = [];
    // Supports ranges such as `2026年5月8日8:00至10日18:00` and
    // `2026年10月20日至11月5日` in addition to fully-written dates.
    for (const match of dateMatches) {
      if (match[1]) year = Number(match[1]);
      if (match[2]) month = Number(match[2]);
      const day = Number(match[3]);
      if (!year || !month || month < 1 || month > 12 || day < 1 || day > 31) continue;
      found.push(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
    }
    return found;
  }))].sort();
  if (!dates.length) return { status: "unknown" };
  const deadline = dates.at(-1);
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return {
    status: deadline < today ? "expired" : "open-or-upcoming",
    deadline,
    evidence: registrationWindows[0]?.passage || passages[0]
  };
}

function attribute(markup, name) {
  const match = String(markup).match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
  return match ? decodeHtml(match[2]) : "";
}

function allowedHost(hostname, domains) {
  const host = hostname.toLowerCase();
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function assertOfficialUrl(candidate, { allowedDomains, allowHttp = false }) {
  let url;
  try { url = new URL(candidate); }
  catch { throw new CollectionSafetyError(`不是可解析的官方链接：${candidate}`); }
  if (!allowedHost(url.hostname, allowedDomains)) {
    throw new CollectionSafetyError(`拒绝访问未登记域名：${url.hostname}`);
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new CollectionSafetyError(`拒绝非登记传输协议：${url.protocol}`);
  }
  return url;
}

function isSemanticErrorPage(finalUrl, text) {
  const probe = `${finalUrl}\n${String(text).slice(0, 9000)}`;
  return /\/(?:404|error)(?:[/?#]|$)|页面不存在|访问的页面不存在|not\s+found/i.test(probe);
}

export async function fetchOfficialText(url, config, fetchImpl = fetch, requestHeaders = {}) {
  const requested = assertOfficialUrl(url, config);
  const response = await fetchImpl(requested, {
    redirect: "follow",
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9",
      ...requestHeaders
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const text = await response.text();
  const finalUrl = response.url || requested.toString();
  assertOfficialUrl(finalUrl, config);
  if (!response.ok) throw new CollectionSafetyError(`官方请求失败：HTTP ${response.status}（${finalUrl}）`);
  if (isSemanticErrorPage(finalUrl, text)) throw new CollectionSafetyError(`官方页面为语义错误页（${finalUrl}）`);
  return { text, finalUrl };
}

export async function fetchOfficialJson(url, config, fetchImpl = fetch, requestHeaders = {}) {
  const result = await fetchOfficialText(url, config, fetchImpl, requestHeaders);
  try { return { ...result, data: JSON.parse(result.text) }; }
  catch { throw new CollectionSafetyError(`官方接口没有返回可解析 JSON：${result.finalUrl}`); }
}

export async function fetchOfficialFormJson(url, form, config, fetchImpl = fetch) {
  const requested = assertOfficialUrl(url, config);
  const response = await fetchImpl(requested, {
    method: "POST",
    redirect: "follow",
    headers: {
      "user-agent": USER_AGENT,
      accept: "application/json,text/plain,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9",
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const text = await response.text();
  const finalUrl = response.url || requested.toString();
  assertOfficialUrl(finalUrl, config);
  if (!response.ok) throw new CollectionSafetyError(`官方请求失败：HTTP ${response.status}（${finalUrl}）`);
  if (isSemanticErrorPage(finalUrl, text)) throw new CollectionSafetyError(`官方页面为语义错误页（${finalUrl}）`);
  try { return { text, finalUrl, data: JSON.parse(text) }; }
  catch { throw new CollectionSafetyError(`官方接口没有返回可解析 JSON：${finalUrl}`); }
}

export async function fetchOfficialBuffer(url, config, fetchImpl = fetch) {
  const requested = assertOfficialUrl(url, config);
  const response = await fetchImpl(requested, {
    redirect: "follow",
    headers: { "user-agent": USER_AGENT, accept: "application/octet-stream,*/*;q=0.8" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const finalUrl = response.url || requested.toString();
  assertOfficialUrl(finalUrl, config);
  if (!response.ok) throw new CollectionSafetyError(`官方附件请求失败：HTTP ${response.status}（${finalUrl}）`);
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (declared > MAX_ATTACHMENT_BYTES) throw new CollectionSafetyError(`官方附件超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB 安全上限：${finalUrl}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_ATTACHMENT_BYTES) throw new CollectionSafetyError(`官方附件超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB 安全上限：${finalUrl}`);
  return { buffer, finalUrl, contentType: response.headers?.get?.("content-type") || "" };
}

export function extractLinks(html, baseUrl, config) {
  const links = [];
  const anchor = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
  for (const match of String(html).matchAll(anchor)) {
    const markup = match[0];
    const href = attribute(markup, "href");
    if (!href || /^(?:javascript:|#)/i.test(href)) continue;
    let url;
    try { url = new URL(href, baseUrl); assertOfficialUrl(url, config); }
    catch { continue; }
    const title = attribute(markup, "title") || textFromHtml(markup);
    const source = String(html);
    const listStart = Math.max(source.lastIndexOf("<li", match.index), source.lastIndexOf("<tr", match.index));
    const listEnd = source.indexOf(listStart === source.lastIndexOf("<tr", match.index) ? "</tr>" : "</li>", match.index);
    const scoped = listStart >= 0 && listEnd >= match.index && listEnd - listStart < 4_000
      ? source.slice(listStart, listEnd + 5)
      : source.slice(Math.max(0, match.index - 80), Math.min(source.length, match.index + markup.length + 120));
    const dateMatch = [...scoped.matchAll(/(20\d{2})[./年-](\d{1,2})[./月-](\d{1,2})/g)].at(-1);
    links.push({
      title: decodeHtml(title),
      officialUrl: url.toString(),
      publishedAt: dateMatch ? `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}` : undefined,
      raw: markup
    });
  }
  return links;
}

function extractEmbeddedOfficialUrls(html, baseUrl, config) {
  const links = [];
  const seen = new Set();
  for (const match of String(html).matchAll(/["'](?:url|link)["']\s*:\s*["']([^"']+\.html(?:[?#][^"']*)?)["']/gi)) {
    try {
      const url = new URL(decodeHtml(match[1]), baseUrl);
      assertOfficialUrl(url, config);
      if (seen.has(url.toString())) continue;
      seen.add(url.toString());
      links.push({ title: "", officialUrl: url.toString(), publishedAt: publicationDateFromUrl(url.toString()), raw: match[0] });
    } catch { /* Ignore malformed or off-domain embedded records. */ }
  }
  return links;
}

function publicationDateFromUrl(url) {
  const match = String(url).match(/(?:t|_)((?:20)\d{2})(\d{2})(\d{2})(?:_|\.|$)/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined;
}

function classifyNotice(title = "") {
  if (/拟录用|公示|面试|资格审核|体检|考察|成绩|笔试/.test(title)) return "exam-process-notice";
  if (/职位表|招考简章|职位查询/.test(title)) return "position-table";
  if (/补充录用|调剂/.test(title)) return "supplementary-recruitment";
  if (/选调(?:应届)?优秀(?:大学|高校)毕业生|定向选调|公开选调(?:公务员)?|选调生|优培/.test(title)) return "selection-program";
  if (/考试录用.*公务员公告|公务员.*招考公告/.test(title)) return "recruitment-announcement";
  return "exam-process-notice";
}

function isRelevantNotice(title) {
  return NOTICE_PATTERN.test(String(title));
}

function isPositionAttachment(attachment) {
  return POSITION_TABLE_FILE_PATTERN.test(attachment.officialUrl) && POSITION_ATTACHMENT_PATTERN.test(`${attachment.label || ""} ${attachment.officialUrl}`);
}

export function extractAttachments(html, baseUrl, config) {
  const seen = new Set();
  return extractLinks(html, baseUrl, config)
    .filter((link) => FILE_ATTACHMENT_PATTERN.test(link.officialUrl) || /(附件|职位表|招考简章|下载)/.test(link.title))
    .map((link) => ({
      label: link.title || decodeURIComponent(new URL(link.officialUrl).pathname.split("/").pop() || "官方附件"),
      officialUrl: link.officialUrl,
      kind: FILE_ATTACHMENT_PATTERN.test(link.officialUrl) ? "file" : "official-link"
    }))
    .filter((attachment) => {
      if (seen.has(attachment.officialUrl)) return false;
      seen.add(attachment.officialUrl);
      return true;
    });
}

function noticeId(prefix, url) {
  return `${prefix}:${createHash("sha256").update(String(url)).digest("hex").slice(0, 18)}`;
}

function normalisePublishedAt(value) {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString().slice(0, 10);
  if (/^\d{13}$/.test(String(value))) return new Date(Number(value)).toISOString().slice(0, 10);
  return value || undefined;
}

function normaliseNotice({ sourceId, title, officialUrl, publishedAt, category, entryRole, attachments = [], detailApiUrl, sectionName }) {
  return {
    id: noticeId(sourceId, officialUrl),
    title: decodeHtml(title),
    category: category || classifyNotice(title),
    publishedAt: normalisePublishedAt(publishedAt) || publicationDateFromUrl(officialUrl),
    officialUrl,
    ...(detailApiUrl ? { detailApiUrl } : {}),
    ...(sectionName ? { sectionName } : {}),
    ...(entryRole ? { entryRole } : {}),
    attachments
  };
}

function titleFromOfficialDetail(html, fallback = "") {
  const source = String(html);
  const candidates = [
    source.match(/<meta\b[^>]*(?:name|property)\s*=\s*["'](?:title|og:title)["'][^>]*content\s*=\s*["']([^"']+)["']/i)?.[1],
    source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1],
    source.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
  ];
  for (const value of candidates) {
    const title = textFromHtml(value || "").replace(/\s*[_-]\s*(?:北京人社|深圳先锋网|北京市人力资源和社会保障局.*|.*网站)\s*$/i, "").trim();
    if (title && !/^title$/i.test(title) && !/^(?:北京人社|深圳先锋网|公告公示|通知公告)(?:\s*[-_]\s*深圳先锋网)?$/i.test(title)) return title;
  }
  return fallback;
}

function uniqueByUrl(notices) {
  const found = new Map();
  for (const notice of notices) found.set(notice.officialUrl, notice);
  return [...found.values()].sort((a, b) => String(b.publishedAt || "").localeCompare(String(a.publishedAt || "")) || a.title.localeCompare(b.title, "zh-CN"));
}

function limited(notices, maxNotices) {
  return maxNotices ? notices.slice(0, maxNotices) : notices;
}

async function enrichStaticNotices(notices, config, fetchImpl) {
  const errors = [];
  const enriched = await Promise.all(notices.map(async (notice) => {
    try {
      let detail;
      try {
        detail = await fetchOfficialText(notice.officialUrl, config, fetchImpl);
      } catch (error) {
        const extensionUrl = config.detailExtFallback && /HTTP 404/.test(error.message) && /\.html(?:[?#].*)?$/i.test(notice.officialUrl)
          ? notice.officialUrl.replace(/\.html(?=([?#].*)?$)/i, "_ext.html")
          : undefined;
        if (!extensionUrl) throw error;
        detail = await fetchOfficialText(extensionUrl, config, fetchImpl);
      }
      const title = titleFromOfficialDetail(detail.text, notice.title);
      return {
        ...notice,
        title,
        category: classifyNotice(title),
        officialUrl: detail.finalUrl,
        attachments: extractAttachments(detail.text, detail.finalUrl, config),
        lifecycle: extractApplicationLifecycle(detail.text, new Date(), notice)
      };
    } catch (error) {
      errors.push({ noticeId: notice.id, officialUrl: notice.officialUrl, error: error.message });
      return { ...notice, detailStatus: "unavailable" };
    }
  }));
  return { notices: enriched, errors };
}

function staticPaginationUrls(html, baseUrl, config, limit = 12) {
  const base = new URL(baseUrl);
  const pages = extractLinks(html, baseUrl, config)
    .map((item) => item.officialUrl)
    .filter((candidate) => {
      const url = new URL(candidate);
      return url.pathname.startsWith(base.pathname.replace(/[^/]*$/, "")) && /(?:index(?:_\d+)?\.html|page(?:=|\/))/.test(`${url.pathname}${url.search}`);
    });
  return [...new Set([base.toString(), ...pages])].slice(0, limit);
}

async function collectStaticNoticeList({ source, entry, fetchImpl, maxPages = 12, maxNotices }) {
  const first = await fetchOfficialText(entry.url, source, fetchImpl);
  const pageUrls = staticPaginationUrls(first.text, first.finalUrl, source, maxPages);
  const pages = [{ url: first.finalUrl, html: first.text }];
  const errors = [];
  for (const url of pageUrls.slice(1)) {
    try {
      const page = await fetchOfficialText(url, source, fetchImpl);
      pages.push({ url: page.finalUrl, html: page.text });
    } catch (error) {
      errors.push({ officialUrl: url, error: error.message });
    }
  }
  const listedLinks = pages.flatMap(({ html, url }) => [
    ...extractLinks(html, url, source),
    ...(source.detailTitleDiscovery ? extractEmbeddedOfficialUrls(html, url, source) : [])
  ]);
  const linkedByUrl = new Map();
  for (const link of listedLinks) {
    const existing = linkedByUrl.get(link.officialUrl);
    if (!existing || (!existing.title && link.title)) linkedByUrl.set(link.officialUrl, link);
  }
  const notices = uniqueByUrl([...linkedByUrl.values()]
    .filter((link) => isRelevantNotice(link.title) || (source.detailTitleDiscovery && !link.title))
    .map((link) => normaliseNotice({
      sourceId: source.sourceId,
      title: link.title,
      officialUrl: link.officialUrl,
      publishedAt: publicationDateFromUrl(link.officialUrl) || link.publishedAt,
      entryRole: entry.role
    })));
  const chosen = limited(notices, maxNotices);
  const detail = await enrichStaticNotices(chosen, source, fetchImpl);
  return { notices: detail.notices.filter((notice) => isRelevantNotice(notice.title)), errors: [...errors, ...detail.errors], pagesVisited: pages.map((page) => page.url), truncated: chosen.length < notices.length };
}

async function collectOfficialJsonNoticeList({ source, fetchImpl, maxNotices }) {
  const feed = await fetchOfficialJson(source.dataApiUrl, source, fetchImpl);
  const notices = uniqueByUrl((feed.data?.articles || []).flatMap((article) => {
    if (!isRelevantNotice(article.title)) return [];
    try {
      assertOfficialUrl(article.url, source);
      return [normaliseNotice({
        sourceId: source.sourceId,
        title: article.title,
        officialUrl: article.url,
        publishedAt: article.date || article.created_at || article.publish_time,
        entryRole: source.entries[0].role
      })];
    } catch { return []; }
  }));
  const chosen = limited(notices, maxNotices);
  const detail = await enrichStaticNotices(chosen, source, fetchImpl);
  return { notices: detail.notices.filter((notice) => isRelevantNotice(notice.title)), errors: detail.errors, pagesVisited: [feed.finalUrl], truncated: chosen.length < notices.length };
}

export async function collectBeijingCivil({ fetchImpl = fetch, maxPages, maxNotices } = {}) {
  const source = SOURCE_CONFIG["beijing-civil"];
  const result = await collectStaticNoticeList({ source, entry: source.entries[0], fetchImpl, maxPages, maxNotices });
  return collectionResult(source, result, { collectionRoute: "官方静态公告列表 → 公告详情 → 附件" });
}

export async function collectStaticSelectionProgram({ sourceId, fetchImpl = fetch, maxPages, maxNotices } = {}) {
  const source = SOURCE_CONFIG[sourceId];
  if (!source) throw new CollectionSafetyError(`未知选调优培来源：${sourceId}`);
  if (source.buaaSelection) return collectBuaaSelectionProgram({ sourceId, fetchImpl, maxPages, maxNotices });
  const result = source.dataApiUrl
    ? await collectOfficialJsonNoticeList({ source, fetchImpl, maxNotices })
    : await collectStaticNoticeList({ source, entry: source.entries[0], fetchImpl, maxPages, maxNotices });
  return collectionResult(source, { ...result, notices: result.notices.filter((notice) => notice.category === "selection-program") }, {
    collectionRoute: source.dataApiUrl ? "官方公告 JSON → 公告详情 → 职位表/附件" : "官方选调优培公告列表 → 公告详情 → 职位表/附件"
  });
}

const BUAA_SELECTION_EXCLUDED = /(拟录用|名单|公示|资格审核|笔试|面试|体检|考察|成绩|调剂|补录|录用)/;

function isBuaaSelectionAnnouncement(title = "", source) {
  const text = String(title).replace(/\s+/g, "");
  return source.buaaSelection.titlePattern.test(text) && !BUAA_SELECTION_EXCLUDED.test(text);
}

function publicClientToken(script) {
  const token = String(script).match(/\btoken\s*:\s*["']([^"']+)["']/)?.[1];
  if (!token) throw new CollectionSafetyError("选调高校公开前端配置未提供详情接口令牌，不能猜测或绕过访问控制。");
  return token;
}

function universityDetailAttachments(fileMap, baseUrl, source) {
  const attachments = [];
  for (const file of fileMap || []) {
    if (!file?.fileUrl) continue;
    try {
      const officialUrl = new URL(file.fileUrl, baseUrl).toString();
      assertOfficialUrl(officialUrl, source);
      attachments.push({
        label: file.fileName || decodeURIComponent(new URL(officialUrl).pathname.split("/").pop() || "官方附件"),
        officialUrl,
        kind: "file"
      });
    } catch { /* Malformed or off-domain attachments are never retained. */ }
  }
  return attachments;
}

export async function collectBuaaSelectionProgram({ sourceId, fetchImpl = fetch, maxPages, maxNotices } = {}) {
  const source = SOURCE_CONFIG[sourceId];
  if (!source?.buaaSelection) throw new CollectionSafetyError(`来源未登记北航选调生采集配方：${sourceId}`);
  const clientConfig = await fetchOfficialText(source.clientConfigUrl, source, fetchImpl);
  const publicToken = publicClientToken(clientConfig.text);
  const first = await fetchOfficialFormJson(source.categoryApiUrl, { categoryId: source.categoryId, pageNo: "1", pageSize: "100" }, source, fetchImpl);
  if (first.data?.state !== 1) throw new CollectionSafetyError("选调高校公开栏目未返回成功状态。");
  const reportedPages = Number(first.data?.object?.newsPage?.totalPage || 1);
  if (!Number.isInteger(reportedPages) || reportedPages < 1) throw new CollectionSafetyError("选调高校公开栏目未返回有效分页信息。");
  const pageLimit = Math.min(reportedPages, maxPages || 12);
  const pages = [first];
  for (let pageNo = 2; pageNo <= pageLimit; pageNo += 1) {
    const page = await fetchOfficialFormJson(source.categoryApiUrl, { categoryId: source.categoryId, pageNo: String(pageNo), pageSize: "100" }, source, fetchImpl);
    if (page.data?.state !== 1) throw new CollectionSafetyError(`选调高校公开栏目第 ${pageNo} 页未返回成功状态。`);
    pages.push(page);
  }
  const candidates = uniqueByUrl(pages.flatMap((page) => page.data?.object?.newsPage?.list || [])
    .filter((item) => isBuaaSelectionAnnouncement(item.title || item.name, source))
    .flatMap((item) => {
      try {
        const officialUrl = new URL(item.url, source.entries[0].url).toString();
        assertOfficialUrl(officialUrl, source);
        return [normaliseNotice({ sourceId: source.sourceId, title: item.title || item.name, officialUrl, publishedAt: item.releaseDate || item.createDate, entryRole: source.entries[0].role })];
      } catch { return []; }
    }));
  const chosen = limited(candidates, maxNotices);
  const errors = [];
  const detailPagesVisited = [];
  const verified = await Promise.all(chosen.map(async (notice) => {
    try {
      const detailId = new URL(notice.officialUrl).searchParams.get("id");
      if (!detailId) throw new CollectionSafetyError("选调高校公告详情链接缺少文章 ID。");
      const detailApiUrl = new URL(source.detailApiUrl);
      detailApiUrl.searchParams.set("id", detailId);
      const detail = await fetchOfficialJson(detailApiUrl.toString(), source, fetchImpl, { token: publicToken });
      detailPagesVisited.push(detail.finalUrl);
      if (detail.data?.state !== 1) throw new CollectionSafetyError("选调高校公开详情接口未返回成功状态。");
      const payload = detail.data?.object?.article || {};
      const title = payload.title || payload.name || notice.title;
      const content = payload.articleData?.content || payload.content || "";
      const detailText = textFromHtml(content);
      if (!isBuaaSelectionAnnouncement(title, source)) throw new CollectionSafetyError("公告详情标题不属于本城市的应届选调／优培范围。");
      if (!source.buaaSelection.issuerPattern.test(detailText)) throw new CollectionSafetyError("公告详情未能确认本城市选调主管机关为发布机关。");
      if (!/(?:应届.{0,20}(?:大学|高校)?毕业生|(?:大学|高校)?毕业生.{0,20}应届)/.test(detailText)) throw new CollectionSafetyError("公告详情未能确认面向应届毕业生。");
      return {
        ...notice,
        title,
        publishedAt: payload.releaseDate || payload.createDate || notice.publishedAt,
        attachments: uniqueAttachments([...extractAttachments(content, notice.officialUrl, source), ...universityDetailAttachments(detail.data?.object?.fileMap, notice.officialUrl, source)]),
        lifecycle: extractApplicationLifecycle(content, new Date(), { title, publishedAt: payload.releaseDate || payload.createDate || notice.publishedAt })
      };
    } catch (error) {
      errors.push({ noticeId: notice.id, officialUrl: notice.officialUrl, error: error.message });
      return undefined;
    }
  }));
  return collectionResult(source, { notices: verified.filter(Boolean), errors, pagesVisited: [clientConfig.finalUrl, ...pages.map((page, index) => `${page.finalUrl}#page=${index + 1}`), ...detailPagesVisited], truncated: pageLimit < reportedPages || chosen.length < candidates.length }, { collectionRoute: "北航就业网选调生公开栏目 API → 城市应届选调公告详情/附件" });
}

export function parseNationalCoreConstants(script) {
  const source = String(script);
  const topicId = source.match(/neu\.hb01Id\s*=[\s\S]*?["']([^"']+)["']\s*,\s*neu\.ahb015/)?.[1]
    || source.match(/neu\.hb01Id\s*=\s*["']([^"']+)["']/)?.[1];
  const apiOrigin = String(script).match(/neu\.cdnServer\s*=\s*["']([^"']*)["']/)?.[1] || undefined;
  const downloadOrigin = String(script).match(/neu\.downloadServer\s*=\s*["']([^"']*)["']/)?.[1] || undefined;
  if (!topicId) throw new CollectionSafetyError("国考官方前端配置缺少当前专题 ID。");
  return { topicId, apiOrigin, downloadOrigin };
}

function nationalCoreScriptUrl(html, finalUrl, source) {
  const sourceTag = String(html).match(/<script\b[^>]*\bsrc\s*=\s*(["'])([^"']*core-constant[^"']*)\1[^>]*>/i);
  if (!sourceTag) throw new CollectionSafetyError("国考首页未公开当前 core-constant 配置，不能猜测专题接口。");
  const url = new URL(sourceTag[2], finalUrl).toString();
  assertOfficialUrl(url, source);
  return url;
}

function flattenNationalGroups(groups = []) {
  const results = [];
  const walk = (group, inheritedTitle = "") => {
    if (!group || typeof group !== "object") return;
    const groupTitle = group.title || group.articleTitle || inheritedTitle;
    for (const article of group.articleList || []) results.push({ ...article, groupTitle });
    for (const child of group.articleColumnList || group.children || []) walk(child, groupTitle);
  };
  for (const group of groups) walk(group);
  return results;
}

function nationalResourceAttachments(resourceList, apiOrigin, source) {
  const output = [];
  for (const resource of resourceList || []) {
    const resourceId = resource.resResourceId || resource.resourceId || resource.id;
    if (!resourceId) continue;
    const url = new URL(`/download/${resourceId}`, apiOrigin).toString();
    assertOfficialUrl(url, source);
    output.push({
      label: resource.resourceName || resource.resResourceName || resource.fileName || "官方附件",
      officialUrl: url,
      kind: "file"
    });
  }
  return output;
}

async function collectNationalEntry(source, entry, fetchImpl, maxNotices) {
  const entryPage = await fetchOfficialText(entry.url, source, fetchImpl);
  const constants = await fetchOfficialText(nationalCoreScriptUrl(entryPage.text, entryPage.finalUrl, source), source, fetchImpl);
  const parsedConstants = parseNationalCoreConstants(constants.text);
  const apiOrigin = parsedConstants.apiOrigin || parsedConstants.downloadOrigin || new URL(entryPage.finalUrl).origin;
  assertOfficialUrl(apiOrigin, source);
  const feedUrl = new URL(`/api/gkhome/article/${parsedConstants.topicId}`, apiOrigin).toString();
  const feed = await fetchOfficialJson(feedUrl, source, fetchImpl);
  const articles = flattenNationalGroups(feed.data?.articleGroupList || feed.data?.result?.articleGroupList || []);
  const relevant = uniqueByUrl(articles
    .filter((article) => isRelevantNotice(`${article.articleTitle || ""} ${article.groupTitle || ""}`))
    .map((article) => {
      const detailApiUrl = new URL(`/api/article/${article.id}`, apiOrigin).toString();
      return normaliseNotice({
        sourceId: source.sourceId,
        title: article.articleTitle,
        officialUrl: detailApiUrl,
        detailApiUrl,
        publishedAt: article.pstrtime || article.ctime,
        entryRole: entry.role
      });
    }));
  const chosen = limited(relevant, maxNotices);
  const errors = [];
  const notices = await Promise.all(chosen.map(async (notice) => {
    try {
      const detail = await fetchOfficialJson(notice.detailApiUrl, source, fetchImpl);
      const article = detail.data?.article || detail.data?.result?.article || {};
      const attachments = [
        ...extractAttachments(article.content || "", detail.finalUrl, source),
        ...nationalResourceAttachments(detail.data?.resourceList || detail.data?.result?.resourceList, apiOrigin, source)
      ];
      return {
        ...notice,
        title: article.articleTitle || notice.title,
        publishedAt: article.pstrtime || article.postDate || notice.publishedAt,
        attachments: uniqueAttachments(attachments),
        lifecycle: extractApplicationLifecycle(article.content || "", new Date(), {
          title: article.articleTitle || notice.title,
          publishedAt: article.pstrtime || article.postDate || notice.publishedAt
        })
      };
    } catch (error) {
      errors.push({ noticeId: notice.id, officialUrl: notice.detailApiUrl, error: error.message });
      return { ...notice, detailStatus: "unavailable" };
    }
  }));
  return { notices, errors, pagesVisited: [entryPage.finalUrl, constants.finalUrl, feed.finalUrl], truncated: chosen.length < relevant.length };
}

export async function collectNationalCivil({ fetchImpl = fetch, maxNotices } = {}) {
  const source = SOURCE_CONFIG["national-civil"];
  const routes = [];
  const errors = [];
  const notices = [];
  for (const entry of source.entries) {
    try {
      const result = await collectNationalEntry(source, entry, fetchImpl, maxNotices);
      routes.push({ entryRole: entry.role, status: "completed", pagesVisited: result.pagesVisited });
      notices.push(...result.notices);
      errors.push(...result.errors);
    } catch (error) {
      routes.push({ entryRole: entry.role, status: "unavailable", error: error.message });
      errors.push({ entryRole: entry.role, officialUrl: entry.url, error: error.message });
    }
  }
  if (!routes.some((route) => route.status === "completed")) throw new CollectionSafetyError("国考主入口和补充录用入口都未完成公开采集。");
  return collectionResult(source, {
    notices: uniqueByUrl(notices),
    errors,
    pagesVisited: routes.flatMap((route) => route.pagesVisited || []),
    truncated: false
  }, { collectionRoute: "官方 SPA 配置 → 官方 JSON 专题 → 公告详情/附件", routes });
}

function flattenShanghaiNews(value, sectionName, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) flattenShanghaiNews(item, sectionName, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  if (value.id && (value.title || value.newsTitle)) {
    output.push({ id: value.id, title: value.title || value.newsTitle, postDate: value.postDate || value.ctime, sectionName: value.sectionName || sectionName });
  }
  for (const [key, child] of Object.entries(value)) {
    if (["id", "title", "newsTitle", "postDate", "ctime", "sectionName"].includes(key)) continue;
    flattenShanghaiNews(child, sectionName, output);
  }
  return output;
}

function isShanghaiTopic(section) {
  return /(考试录用公务员|公开遴选|公开选调|聘任制公务员|选调优秀大学毕业生|定向选调|选调生|优培)/.test(`${section.name || ""} ${section.title || ""}`) && !/(辅警|辅助文员)/.test(`${section.name || ""} ${section.title || ""}`);
}

export async function collectShanghaiCivil({ sourceId = "shanghai-civil", selectionOnly = false, fetchImpl = fetch, maxNotices } = {}) {
  const source = SOURCE_CONFIG[sourceId];
  const apiOrigin = "https://shacs.gov.cn";
  const sectionUrl = new URL("/gwyj/api/gwy-column-section.json?listChild=true", apiOrigin).toString();
  const sectionData = await fetchOfficialJson(sectionUrl, source, fetchImpl);
  if (sectionData.data?.state && sectionData.data.state !== "SUCCESS") throw new CollectionSafetyError("上海市考专题接口未返回 SUCCESS。");
  const sections = sectionData.data?.result?.child || sectionData.data?.result?.children || [];
  const selected = sections.filter(isShanghaiTopic);
  if (!selected.length) throw new CollectionSafetyError("上海市考官方接口未返回可识别的公务员考试专题。");
  const errors = [];
  const pagesVisited = [sectionData.finalUrl];
  const records = [];
  for (const section of selected) {
    const newsUrl = new URL(`/gwyj/api/child-section-and-news.json?sectionId=${encodeURIComponent(section.id)}&pageSize=2000`, apiOrigin).toString();
    try {
      const news = await fetchOfficialJson(newsUrl, source, fetchImpl);
      if (news.data?.state && news.data.state !== "SUCCESS") throw new CollectionSafetyError(`上海专题 ${section.id} 未返回 SUCCESS。`);
      pagesVisited.push(news.finalUrl);
      records.push(...flattenShanghaiNews(news.data?.result?.secNews || news.data?.result?.news || [], section.name || section.title));
    } catch (error) {
      errors.push({ sectionId: section.id, error: error.message });
    }
  }
  const relevant = uniqueByUrl(records
    .filter((record) => isRelevantNotice(record.title))
    .map((record) => {
      const detailApiUrl = new URL(`/gwyj/api/show-news.json?id=${encodeURIComponent(record.id)}`, apiOrigin).toString();
      return normaliseNotice({
        sourceId: source.sourceId,
        title: record.title,
        officialUrl: detailApiUrl,
        detailApiUrl,
        publishedAt: record.postDate,
        sectionName: record.sectionName
      });
    }));
  // The independent selection feed must not spend its detail budget on ordinary
  // civil-service notices from the shared Shanghai topic directory. Besides
  // being wasteful, a historical generic notice returning 502 must not make a
  // successfully checked selection feed look incomplete.
  const sourceRelevant = selectionOnly ? relevant.filter((notice) => notice.category === "selection-program") : relevant;
  const chosen = limited(sourceRelevant, maxNotices);
  const notices = await Promise.all(chosen.map(async (notice) => {
    try {
      const detail = await fetchOfficialJson(notice.detailApiUrl, source, fetchImpl);
      const payload = detail.data?.result || detail.data?.article || {};
      return {
        ...notice,
        title: payload.title || notice.title,
        publishedAt: payload.postDate || payload.ctime || notice.publishedAt,
        attachments: extractAttachments(payload.content || "", detail.finalUrl, source),
        lifecycle: extractApplicationLifecycle(payload.content || "", new Date(), {
          title: payload.title || notice.title,
          publishedAt: payload.postDate || payload.ctime || notice.publishedAt
        })
      };
    } catch (error) {
      errors.push({ noticeId: notice.id, officialUrl: notice.detailApiUrl, error: error.message });
      return { ...notice, detailStatus: "unavailable" };
    }
  }));
  const sourceNotices = selectionOnly ? notices.filter((notice) => notice.category === "selection-program") : notices;
  return collectionResult(source, { notices: sourceNotices, errors, pagesVisited, truncated: chosen.length < sourceRelevant.length }, { collectionRoute: selectionOnly ? "官方选调生专题 JSON → 公告详情/附件" : "官方专题 JSON → 专题公告 JSON → 公告详情/附件" });
}

export async function collectShanghaiSelectionProgram({ fetchImpl = fetch, maxNotices } = {}) {
  return collectShanghaiCivil({ sourceId: "shanghai-selection-program", selectionOnly: true, fetchImpl, maxNotices });
}

function parseGuangdongNoticeLinks(html, baseUrl, source) {
  const direct = extractLinks(html, baseUrl, source).filter((link) => isRelevantNotice(link.title));
  const popupPattern = /openLinkWindow\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const popup = [...String(html).matchAll(popupPattern)].map((match) => {
    const nearby = String(html).slice(Math.max(0, match.index - 240), Math.min(String(html).length, match.index + 260));
    const title = textFromHtml(nearby).match(/广东[^<>]{0,90}(?:公务员|选调)[^<>]{0,90}/)?.[0] || "广东省公务员考试公告";
    const date = nearby.match(/\[(20\d{2}-\d{2}-\d{2})\]/)?.[1];
    try {
      const url = new URL(match[1], baseUrl); assertOfficialUrl(url, source);
      return { title, officialUrl: url.toString(), publishedAt: date };
    } catch { return undefined; }
  }).filter(Boolean).filter((link) => isRelevantNotice(link.title));
  return [...direct, ...popup];
}

export async function collectGuangdongCivil({ sourceId, fetchImpl = fetch, maxPages, maxNotices } = {}) {
  const source = SOURCE_CONFIG[sourceId];
  if (!source) throw new CollectionSafetyError(`未知广东来源：${sourceId}`);
  const primary = source.entries[0];
  try {
    const listed = await collectStaticNoticeList({ source, entry: primary, fetchImpl, maxPages, maxNotices });
    return collectionResult(source, listed, {
      collectionRoute: "广东组织工作网公告列表 → 公告详情 → 官方附件/压缩包",
      cityFilter: source.defaultCity,
      secondaryOfficialEntry: source.entries[1].url
    });
  } catch (primaryError) {
    const secondary = source.entries[1];
    const page = await fetchOfficialText(secondary.url, source, fetchImpl);
    const notices = uniqueByUrl(parseGuangdongNoticeLinks(page.text, page.finalUrl, source)
      .map((link) => normaliseNotice({
        sourceId: source.sourceId,
        title: link.title,
        officialUrl: link.officialUrl,
        publishedAt: link.publishedAt,
        entryRole: secondary.role
      })));
    const chosen = limited(notices, maxNotices);
    const detail = await enrichStaticNotices(chosen, source, fetchImpl);
    return collectionResult(source, {
      notices: detail.notices,
      errors: [{ officialUrl: primary.url, error: primaryError.message }, ...detail.errors],
      pagesVisited: [page.finalUrl],
      truncated: chosen.length < notices.length
    }, {
      collectionRoute: "广东省公务员考试系统公告回退 → 广东组织工作网公告详情 → 官方附件/压缩包",
      cityFilter: source.defaultCity,
      primaryOfficialEntry: primary.url
    });
  }
}

function uniqueAttachments(attachments) {
  const found = new Map();
  for (const attachment of attachments) found.set(attachment.officialUrl, attachment);
  return [...found.values()];
}

function collectionResult(source, result, extra = {}) {
  const notices = uniqueByUrl(result.notices || []);
  return {
    sourceId: source.sourceId,
    sourceLabel: source.label,
    collectionMethod: "script",
    collectedAt: new Date().toISOString(),
    status: result.errors?.length ? "completed-partial" : "completed",
    officialEntries: source.entries,
    pagesVisited: [...new Set(result.pagesVisited || [])],
    notices,
    noticeCount: notices.length,
    errors: result.errors || [],
    truncatedForDemo: Boolean(result.truncated),
    ...extra
  };
}

function normaliseHeader(value) {
  return String(value ?? "")
    .replace(/[\r\n\t\s]/g, "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[:：]/g, "")
    .trim();
}

const COLUMN_ALIASES = {
  organization: ["招录机关", "用人单位", "单位名称", "招考单位", "部门名称", "部门"],
  positionName: ["职位名称", "招考职位", "职位"],
  positionCode: ["职位代码", "职位编号", "职位ID", "岗位代码", "招录职位代码"],
  location: ["工作地点", "工作单位", "职位所在地", "所在地区", "招考地区", "地区", "地市", "市"],
  major: ["专业要求", "专业", "专业目录"],
  education: ["学历要求", "学历"],
  degree: ["学位要求", "学位"],
  politicalStatus: ["政治面貌", "中共党员"],
  candidateType: ["招考对象", "报考对象", "职位属性", "人员类别"],
  remarks: ["备注", "其他条件", "职位简介", "工作简介"]
};

function findHeaderRow(rows) {
  for (let index = 0; index < Math.min(rows.length, 40); index += 1) {
    const header = rows[index].map(normaliseHeader);
    const hits = Object.values(COLUMN_ALIASES).filter((aliases) => header.some((item) => aliases.some((alias) => item === alias || item.includes(alias)))).length;
    if (hits >= 3 && header.some((item) => /职位/.test(item))) return { index, header };
  }
  return undefined;
}

function columnIndex(header, aliases) {
  return header.findIndex((item) => aliases.some((alias) => item === alias || item.includes(alias)));
}

function rowValue(row, header, key) {
  const index = columnIndex(header, COLUMN_ALIASES[key]);
  return index >= 0 ? String(row[index] ?? "").trim() : "";
}

function cityVariants(city) {
  const stripped = String(city || "").replace(/市$/, "");
  return [...new Set([city, stripped].filter(Boolean))];
}

function matchesCity(record, city) {
  if (!city) return true;
  const haystack = Object.values(record).join(" ");
  return cityVariants(city).some((item) => haystack.includes(item));
}

export function parsePositionWorkbook(buffer, { city, fileName = "官方职位表" } = {}) {
  if (buffer.length > MAX_WORKBOOK_BYTES) throw new CollectionSafetyError(`工作簿 ${fileName} 超过 ${MAX_WORKBOOK_BYTES / 1024 / 1024}MB 解析上限。`);
  let workbook;
  try { workbook = XLSX.read(buffer, { type: "buffer", raw: false, cellDates: true }); }
  catch (error) { throw new CollectionSafetyError(`无法解析官方工作簿 ${fileName}：${error.message}`); }
  const sheets = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
    const headerInfo = findHeaderRow(rows);
    if (!headerInfo) continue;
    const positions = rows.slice(headerInfo.index + 1)
      .filter((row) => row.some((cell) => String(cell ?? "").trim()))
      .map((row) => ({
        organization: rowValue(row, headerInfo.header, "organization"),
        positionName: rowValue(row, headerInfo.header, "positionName"),
        positionCode: rowValue(row, headerInfo.header, "positionCode"),
        location: rowValue(row, headerInfo.header, "location"),
        major: rowValue(row, headerInfo.header, "major"),
        education: rowValue(row, headerInfo.header, "education"),
        degree: rowValue(row, headerInfo.header, "degree"),
        politicalStatus: rowValue(row, headerInfo.header, "politicalStatus"),
        candidateType: rowValue(row, headerInfo.header, "candidateType"),
        remarks: rowValue(row, headerInfo.header, "remarks")
      }))
      .filter((row) => row.positionName || row.positionCode || row.organization);
    sheets.push({
      sheetName,
      headerRow: headerInfo.index + 1,
      totalRows: positions.length,
      cityFilteredRows: positions.filter((record) => matchesCity(record, city))
    });
  }
  if (!sheets.length) throw new CollectionSafetyError(`工作簿 ${fileName} 未找到包含职位字段的表头。`);
  return sheets;
}

function isZip(buffer) {
  return buffer.length >= 4 && buffer.subarray(0, 4).toString("ascii") === "PK\x03\x04";
}

function parsePositionArtifact(buffer, attachment, city) {
  if (/\.(?:xls|xlsx|csv)(?:$|[?#])/i.test(attachment.officialUrl) || !isZip(buffer)) {
    return [{ fileName: attachment.label, sheets: parsePositionWorkbook(buffer, { city, fileName: attachment.label }) }];
  }
  let archive;
  try { archive = new AdmZip(buffer); }
  catch (error) { throw new CollectionSafetyError(`无法打开官方附件压缩包：${error.message}`); }
  const workbooks = archive.getEntries()
    .filter((entry) => !entry.isDirectory && /\.(?:xls|xlsx|csv)$/i.test(entry.entryName));
  if (!workbooks.length) throw new CollectionSafetyError("官方附件压缩包未包含可识别的职位表工作簿。");
  const parsed = [];
  for (const entry of workbooks) {
    try {
      const data = entry.getData();
      parsed.push({ fileName: entry.entryName, sheets: parsePositionWorkbook(data, { city, fileName: entry.entryName }) });
    } catch {
      // Archives often contain both a position table and catalogues/guides.
      // Only a worksheet with a recognisable position header is retained.
    }
  }
  if (!parsed.length) throw new CollectionSafetyError("官方附件压缩包中的工作簿均未包含可识别的职位表表头。");
  return parsed;
}

export async function parsePositionTables(result, { city, fetchImpl = fetch } = {}) {
  const source = SOURCE_CONFIG[result.sourceId];
  if (!source) throw new CollectionSafetyError(`没有来源配置：${result.sourceId}`);
  const positionBearingCategories = new Set(["position-table", "recruitment-announcement", "supplementary-recruitment", "selection-program"]);
  const candidates = uniqueAttachments(result.notices
    .filter((notice) => positionBearingCategories.has(notice.category))
    .flatMap((notice) => notice.attachments || []))
    .filter(isPositionAttachment);
  const tables = [];
  const errors = [];
  for (const attachment of candidates) {
    try {
      const downloaded = await fetchOfficialBuffer(attachment.officialUrl, source, fetchImpl);
      const parsedFiles = parsePositionArtifact(downloaded.buffer, attachment, city || source.defaultCity);
      tables.push({
        attachment: { ...attachment, officialUrl: downloaded.finalUrl },
        byteLength: downloaded.buffer.length,
        sha256: createHash("sha256").update(downloaded.buffer).digest("hex"),
        files: parsedFiles
      });
    } catch (error) {
      errors.push({ attachment: attachment.officialUrl, error: error.message });
    }
  }
  return { city: city || source.defaultCity, tables, errors };
}

export async function collectPublicExam({ sourceId, fetchImpl = fetch, maxPages, maxNotices, parseTables = false, city } = {}) {
  let result;
  if (sourceId === "national-civil") result = await collectNationalCivil({ fetchImpl, maxNotices });
  else if (sourceId === "beijing-civil") result = await collectBeijingCivil({ fetchImpl, maxPages, maxNotices });
  else if (sourceId === "shanghai-civil") result = await collectShanghaiCivil({ fetchImpl, maxNotices });
  else if (sourceId === "shanghai-selection-program") result = await collectShanghaiSelectionProgram({ fetchImpl, maxNotices });
  else if (sourceId === "guangzhou-civil" || sourceId === "shenzhen-civil") result = await collectGuangdongCivil({ sourceId, fetchImpl, maxPages, maxNotices });
  else if (["beijing-selection-program", "guangzhou-selection-program", "shenzhen-selection-program"].includes(sourceId)) result = await collectStaticSelectionProgram({ sourceId, fetchImpl, maxPages, maxNotices });
  else throw new CollectionSafetyError(`不支持的来源：${sourceId}`);
  if (!parseTables) return result;
  const positionTables = await parsePositionTables(result, { city, fetchImpl });
  return {
    ...result,
    positionTables,
    status: result.errors.length || positionTables.errors.length ? "completed-partial" : "completed"
  };
}

export function buildSnapshot(result) {
  return {
    version: 1,
    sourceId: result.sourceId,
    collectedAt: result.collectedAt,
    notices: Object.fromEntries(result.notices.map((notice) => {
      const fingerprint = createHash("sha256").update(JSON.stringify({
        title: notice.title,
        publishedAt: notice.publishedAt,
        attachments: (notice.attachments || []).map((attachment) => attachment.officialUrl).sort()
      })).digest("hex");
      return [notice.id, { fingerprint, officialUrl: notice.officialUrl, title: notice.title }];
    }))
  };
}

export function diffSnapshots(previous, next) {
  const prior = previous?.notices || {};
  const current = next?.notices || {};
  const changes = [];
  for (const [id, notice] of Object.entries(current)) {
    changes.push({ id, title: notice.title, officialUrl: notice.officialUrl, change: !prior[id] ? "new" : prior[id].fingerprint !== notice.fingerprint ? "changed" : "unchanged" });
  }
  for (const [id, notice] of Object.entries(prior)) {
    if (!current[id]) changes.push({ id, title: notice.title, officialUrl: notice.officialUrl, change: "not-seen-this-run" });
  }
  return changes;
}

export function summarizeCollection(result) {
  const parsedPositionCount = result.positionTables?.tables
    .flatMap((table) => table.files)
    .flatMap((file) => file.sheets)
    .reduce((total, sheet) => total + sheet.cityFilteredRows.length, 0) || 0;
  return {
    sourceId: result.sourceId,
    sourceLabel: result.sourceLabel,
    collectionMethod: result.collectionMethod,
    status: result.status,
    collectedAt: result.collectedAt,
    officialEntries: result.officialEntries,
    pagesVisited: result.pagesVisited,
    noticeCount: result.noticeCount,
    attachmentCount: result.notices.reduce((total, notice) => total + (notice.attachments?.length || 0), 0),
    parsedPositionTableCount: result.positionTables?.tables.length || 0,
    cityFilteredPositionCount: parsedPositionCount,
    errors: result.errors,
    positionTableErrors: result.positionTables?.errors || [],
    truncatedForDemo: result.truncatedForDemo,
    sampleNotices: result.notices.slice(0, 5).map(({ title, category, publishedAt, officialUrl, attachments }) => ({ title, category, publishedAt, officialUrl, attachmentCount: attachments.length }))
  };
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function numberArgument(name) {
  const value = readArgument(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new CollectionSafetyError(`${name} 必须是正整数。`);
  return parsed;
}

async function main() {
  const sourceId = readArgument("--source");
  if (!sourceId) throw new CollectionSafetyError("请用 --source 指定 national-civil、beijing-civil、shanghai-civil、guangzhou-civil 或 shenzhen-civil。");
  const result = await collectPublicExam({
    sourceId,
    maxPages: numberArgument("--max-pages"),
    maxNotices: numberArgument("--max-notices"),
    parseTables: process.argv.includes("--parse-position-tables"),
    city: readArgument("--city")
  });
  const snapshotPath = readArgument("--snapshot");
  if (snapshotPath) {
    let previous;
    try { previous = JSON.parse(await readFile(snapshotPath, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const next = buildSnapshot(result);
    result.snapshot = { path: snapshotPath, changes: diffSnapshots(previous, next) };
    await writeFile(snapshotPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(process.argv.includes("--summary") ? summarizeCollection(result) : result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: "collection-failed", error: error.message }, null, 2));
    process.exitCode = 1;
  });
}
