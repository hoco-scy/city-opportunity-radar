#!/usr/bin/env node
/**
 * Public notice-feed collector for official sources that expose a server
 * rendered recruitment / announcement page.  It is deliberately narrower
 * than a generic crawler: only registered official domains are followed, and
 * it never treats a notice as a publishable job without a concrete position.
 */
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const RECRUITMENT_LINK = /(招聘|招考|招录|人才|校园|校招|应届|毕业生|选调|优培|事业单位|岗位|职位)/;
const GENERIC_NAVIGATION = /^(招聘|人才招聘|招考招聘|校园招聘|社会招聘|招聘信息|招聘动态|事业单位)$/;
const ERROR_PAGE = /(?:页面不存在|not found|error 404|访问出错|系统错误)/i;
const execFileAsync = promisify(execFile);

export class OfficialNoticeFeedError extends Error {
  constructor(message) { super(message); this.name = "OfficialNoticeFeedError"; }
}

function normalizeText(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&gt;/gi, ">").replace(/&lt;/gi, "<").replace(/&bull;/gi, "•")
    .replace(/\s+/g, " ").trim();
}

function officialDomains(source) {
  return new Set((source.domains || []).map((domain) => String(domain).toLowerCase()));
}

function isOfficialUrl(url, domains) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase();
    return [...domains].some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch { return false; }
}

function extractAnchors(html, baseUrl, domains) {
  const links = new Map();
  const anchor = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchor.exec(html))) {
    const title = normalizeText(match[3]);
    if (!title || GENERIC_NAVIGATION.test(title) || !RECRUITMENT_LINK.test(title)) continue;
    const checkUrl = match[2].match(/^javascript:checkUrl\((['"])(.*?)\1\)/i)?.[2];
    if (/^javascript:/i.test(match[2]) && !checkUrl) continue;
    let url;
    try { url = new URL(checkUrl || match[2], baseUrl).toString(); } catch { continue; }
    const hostname = new URL(url).hostname.toLowerCase();
    const trustedRelay = hostname.endsWith(".gov.cn") || hostname === "mp.weixin.qq.com";
    if (!isOfficialUrl(url, domains) && !trustedRelay) continue;
    links.set(url, { url, title, trustedRelay: !isOfficialUrl(url, domains) });
  }
  return [...links.values()];
}

async function curlPage(requestedUrl, headers = {}) {
  const headerArgs = Object.entries(headers).flatMap(([name, value]) => ["-H", name + ": " + value]);
  const marker = "\n__RADAR_META__";
  const { stdout } = await execFileAsync("curl", [
    "-sS", "-L", "--max-time", "30", "--max-redirs", "5", "-A", "Mozilla/5.0", ...headerArgs,
    "-w", marker + "%{http_code}\t%{url_effective}", requestedUrl
  ], { encoding: "utf8", maxBuffer: 12_000_000 });
  const index = stdout.lastIndexOf(marker);
  if (index < 0) throw new OfficialNoticeFeedError("系统 HTTP 客户端未返回状态元数据。");
  const [status, finalUrl] = stdout.slice(index + marker.length).split("\t");
  return { ok: Number(status) >= 200 && Number(status) < 400, status: Number(status), url: finalUrl || requestedUrl, viaCurl: true, text: async () => stdout.slice(0, index) };
}

async function requestPage(requestedUrl, fetchImpl, headers = {}) {
  try {
    return await fetchImpl(requestedUrl, {
      redirect: "follow",
      headers: { accept: "text/html,application/xhtml+xml", "user-agent": "Mozilla/5.0", ...headers },
      signal: AbortSignal.timeout(25_000)
    });
  } catch (error) {
    if (error?.kind === "circuit-open" || (fetchImpl !== globalThis.fetch && !fetchImpl.isResilientCollectionFetch)) throw error;
    return curlPage(requestedUrl, headers);
  }
}

async function fetchOfficialPage(requestedUrl, domains, fetchImpl, depth = 0) {
  let response = await requestPage(requestedUrl, fetchImpl);
  let html = await response.text();
  let finalUrl = response.url || requestedUrl;
  let semantic404 = ERROR_PAGE.test(html) || /(?:\/404|\/error)(?:[/?#]|$)/i.test(finalUrl);
  if ((!response.ok || semantic404) && (fetchImpl === globalThis.fetch || fetchImpl.isResilientCollectionFetch) && !response.viaCurl) {
    response = await curlPage(requestedUrl);
    html = await response.text();
    finalUrl = response.url || requestedUrl;
    semantic404 = ERROR_PAGE.test(html) || /(?:\/404|\/error)(?:[/?#]|$)/i.test(finalUrl);
  }
  if (!isOfficialUrl(finalUrl, domains)) throw new OfficialNoticeFeedError("官方来源请求跳转到未登记域名，已停止采集。");
  if (depth < 2 && html.length < 5_000) {
    const scriptTarget = html.match(/window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i)?.[1];
    if (scriptTarget) return fetchOfficialPage(new URL(scriptTarget, finalUrl).toString(), domains, fetchImpl, depth + 1);
  }
  return { ok: response.ok && !semantic404, semantic404, finalUrl, html };
}

function primaryUrls(source) {
  return [...new Set([source.collectionEntryUrl || source.entryUrl, ...(source.alternateEntryUrls || [])].filter(Boolean))];
}

export async function collectOfficialNoticeFeed({ source, fetchImpl = fetch, detailLimit = 30 } = {}) {
  if (!source?.id || !source.entryUrl) throw new OfficialNoticeFeedError("官方公告采集缺少来源登记。");
  const domains = officialDomains(source);
  const urls = primaryUrls(source);
  // The shared transport already performs the three transient retries.  Only
  // visit each registered alternate once here to avoid multiplying them.
  const attemptsRequired = fetchImpl.isResilientCollectionFetch
    ? urls.length
    : Math.max(["critical", "active"].includes(source.tier) ? 3 : 1, urls.length);
  const accessEvidence = [];
  let page;

  for (let index = 0; index < attemptsRequired && !page; index += 1) {
    const requestedUrl = urls[index % urls.length];
    try {
      const result = await fetchOfficialPage(requestedUrl, domains, fetchImpl);
      if (result.ok) {
        page = { ...result, requestedUrl };
        accessEvidence.push({ requestedUrl, finalUrl: result.finalUrl, outcome: "official-page", recipe: "已读取官方公告/招聘页，抽取同域招聘链接后逐页检查。" });
      } else if (result.semantic404) {
        accessEvidence.push({ requestedUrl, outcome: "semantic-404", recipe: "官方入口返回明确的不存在或错误页。" });
      } else {
        accessEvidence.push({ requestedUrl, outcome: "network-error", recipe: "官方入口未返回可用页面。" });
      }
    } catch (error) {
      const accessControlled = error?.circuitReason === "blocked";
      accessEvidence.push({ requestedUrl, outcome: accessControlled ? "access-control" : "network-error", recipe: accessControlled ? "官方入口触发访问控制，已停止继续请求且不尝试绕过。" : `官方入口本轮无法读取：${error?.name || "fetch-error"}。` });
    }
  }

  if (!page) {
    return {
      sourceId: source.id,
      collectionMethod: "official-notice-feed",
      collectionRoute: "登记官方公告/招聘页 → 同域招聘链接 → 公告正文",
      status: accessEvidence.some((item) => item.outcome === "access-control") ? "accessible-incomplete" : accessEvidence.some((item) => item.outcome === "semantic-404") ? "semantic-404" : "temporarily-unavailable",
      accessEvidence, attempts: accessEvidence.length,
      collected: null, afterFilter: null, noticeItems: [],
      reason: accessEvidence.some((item) => item.outcome === "access-control") ? "官方入口触发访问控制，本轮已停止继续请求并保留上次结果；不尝试绕过，也不据此判断无岗位。" : "本轮未取得可读取的官方公告/招聘页，不能据此判断无岗位。"
    };
  }

  const anchors = extractAnchors(page.html, page.finalUrl, domains);
  // A source such as the central-enterprise roster is intentionally a source
  // registry, not a job board.  Reading it still verifies the official
  // organisation universe but cannot create a position lead on its own.
  if (source.id === "central-enterprise-roster") {
    return {
      sourceId: source.id, collectionMethod: "official-roster-refresh",
      collectionRoute: "国务院国资委官方中央企业名录页 → 名录变更核对",
      status: "checked-roster-current", accessEvidence, attempts: accessEvidence.length,
      collected: 1, afterFilter: 0, noticeItems: [],
      reason: "已读取官方中央企业名录页；名录用于限定重点单位范围，不把名录本身当作招聘岗位。"
    };
  }
  if (!anchors.length) {
    return {
      sourceId: source.id, collectionMethod: "official-notice-feed",
      collectionRoute: "登记官方公告/招聘页 → 同域招聘链接 → 公告正文",
      status: "accessible-incomplete", accessEvidence, attempts: accessEvidence.length,
      collected: null, afterFilter: null, noticeItems: [],
      reason: "已读取官方入口，但专用脚本尚未从当前页面结构中解析出可安全跟进的招聘列表；该来源需要继续适配，不能按 0 条理解。"
    };
  }

  const selected = anchors.slice(0, detailLimit);
  const noticeItems = [];
  for (const anchor of selected) {
    if (anchor.trustedRelay) {
      noticeItems.push({
        title: anchor.title,
        url: anchor.url,
        evidence: "该链接由已登记的政府官方公告列表直接给出；仅记录公告线索，不据此发布具体岗位。"
      });
      continue;
    }
    try {
      const detail = await fetchOfficialPage(anchor.url, domains, fetchImpl);
      if (!detail.ok) continue;
      const detailText = normalizeText(detail.html);
      // This is a notice-level relevance filter.  It deliberately remains
      // broad: a selected notice can still contain a later position table.
      if (RECRUITMENT_LINK.test(detailText)) {
        noticeItems.push({ title: anchor.title, url: detail.finalUrl });
      }
    } catch { /* a single detail failure does not erase other public notices */ }
  }
  if (!noticeItems.length) {
    return {
      sourceId: source.id, collectionMethod: "official-notice-feed",
      collectionRoute: "登记官方公告/招聘页 → 同域招聘链接 → 公告正文",
      status: "accessible-incomplete", accessEvidence, attempts: accessEvidence.length,
      collected: null, afterFilter: null, noticeItems: [],
      reason: "已发现招聘导航或链接，但专用脚本没有取得可核验的公告正文；可能跳转到独立招聘系统或动态列表，需要继续适配，不能按 0 条理解。"
    };
  }
  return {
    sourceId: source.id,
    collectionMethod: "official-notice-feed",
    collectionRoute: "登记官方公告/招聘页 → 同域招聘链接 → 公告正文",
    status: "checked-official-notice-feed", accessEvidence, attempts: accessEvidence.length,
    collected: noticeItems.length, afterFilter: noticeItems.length, noticeItems,
    reason: `已读取 ${noticeItems.length} 条同域招聘/公告正文；公告阶段不按医疗词删减，待取得具体岗位和官方资格字段后再判断专业是否可报。`
  };
}

async function main() {
  const sourceIndex = process.argv.indexOf("--source");
  const sourceId = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : null;
  if (!sourceId) throw new OfficialNoticeFeedError("请使用 --source <source-id> 指定已登记来源。");
  const registry = JSON.parse(await readFile(new URL("../data/source-registry.json", import.meta.url), "utf8"));
  const source = registry.sources.find((item) => item.id === sourceId);
  if (!source) throw new OfficialNoticeFeedError(`未找到来源：${sourceId}`);
  console.log(JSON.stringify(await collectOfficialNoticeFeed({ source }), null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
