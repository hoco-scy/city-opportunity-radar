#!/usr/bin/env node
/**
 * Public, read-only collector for China Telecom's campus recruitment list.
 *
 * It deliberately starts from the official page, obtains that page's current
 * pagination token, applies the official work-place filter, and refuses to
 * traverse an unfiltered result set.  It needs Node 18+ only; no browser,
 * cookie jar, package install, credential, or local state is required.
 *
 * Example (safe demonstration: only the first two filtered pages):
 *   node scripts/collect-chinatelecom.mjs --city 北京 --max-pages 2
 *
 * A scheduled task may use --all-pages only after the native city filter is
 * accepted.  Output is JSON on stdout; this script never writes jobs into the
 * public site by itself.
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SOURCE_ID = "chinatelecom-careers";
const USER_AGENT = "Mozilla/5.0 (compatible; OpportunityRadar/1.0; +https://github.com/hoco-scy/beijing-opportunity-radar)";

export class CollectionSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = "CollectionSafetyError";
  }
}

function decodeHtml(value = "") {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function textOf(html = "") {
  return decodeHtml(html.replace(/<[^>]*>/g, " "));
}

function attribute(html, name) {
  const match = html.match(new RegExp(`${name}="([^"]*)"`, "i"));
  return match ? decodeHtml(match[1]) : "";
}

export function extractOperationalToken(html) {
  const match = html.match(/webPosition210!getPostListByConditionShowPic\?operational=([^'"&\s]+)/i);
  if (!match) throw new CollectionSafetyError("官方页面未暴露当前公开分页令牌，不能安全执行筛选后采集。");
  return match[1];
}

export function extractPagination(html) {
  const normalized = html.replace(/&nbsp;/gi, " ");
  const match = normalized.match(/当前页面:\s*\d+\s*\/\s*(\d+)\s*共\s*(\d+)\s*条记录/i);
  if (!match) throw new CollectionSafetyError("官方页面未呈现可计数的分页结果或明确空状态。");
  return { pages: Number(match[1]), total: Number(match[2]) };
}

export function parsePositions(html, origin) {
  const rows = html.match(/<tr(?:\s[^>]*)?>[\s\S]*?<\/tr>/gi) || [];
  const seen = new Set();
  const positions = [];
  for (const row of rows) {
    if (!/webPosition210!getOnePosition/i.test(row)) continue;
    const hrefMatch = row.match(/href="([^"]*webPosition210!getOnePosition[^"]*)"/i);
    const cells = [...row.matchAll(/<td(?:\s[^>]*)?>([\s\S]*?)<\/td>/gi)].map((match) => match[1]);
    if (!hrefMatch || cells.length < 6) continue;
    const detailUrl = new URL(decodeHtml(hrefMatch[1]), origin).toString();
    if (seen.has(detailUrl)) continue;
    seen.add(detailUrl);
    positions.push({
      title: attribute(cells[0], "title") || textOf(cells[0]),
      category: textOf(cells[1]),
      organization: attribute(cells[2], "title") || textOf(cells[2]),
      headcount: textOf(cells[3]),
      location: attribute(cells[4], "title") || textOf(cells[4]),
      publishedAt: textOf(cells[5]),
      officialUrl: detailUrl
    });
  }
  return positions;
}

export function buildFilteredUrl({ entryUrl, operational, city, page, rowSize }) {
  const url = new URL("/wt/TELE/web/index/webPosition210!getPostListByConditionShowPic", entryUrl);
  const params = {
    operational,
    positionType: "0",
    comPart: "",
    sicCorpCode: "",
    brandCode: "",
    releaseTime: "0",
    trademark: "0",
    useForm: "0",
    recruitType: "1",
    lanType: "",
    positionName: "",
    workPlace: city,
    keyWord: "",
    columnId: "1",
    siteId: "",
    projectId: "",
    "pc.currentPage": String(page),
    "pc.rowSize": String(rowSize)
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

async function fetchOfficial(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    redirect: "follow",
    headers: {
      "user-agent": USER_AGENT,
      "accept": "text/html,application/xhtml+xml",
      "accept-language": "zh-CN,zh;q=0.9"
    },
    signal: AbortSignal.timeout(30_000)
  });
  const html = await response.text();
  if (!response.ok) throw new CollectionSafetyError(`官方页面请求失败：HTTP ${response.status}（${response.url || url}）。`);
  if (/\/(?:404|error)(?:[/?#]|$)|页面不存在|not\s+found/i.test(`${response.url || ""}\n${html.slice(0, 8000)}`)) {
    throw new CollectionSafetyError("官方页面落入语义错误页，不能作为职位列表处理。");
  }
  return { html, finalUrl: response.url || String(url) };
}

export async function collectChinaTelecom({ entryUrl, city, maxPages = 3, allPages = false, rowSize = 10, fetchImpl = fetch }) {
  if (!city) throw new CollectionSafetyError("必须提供城市，拒绝遍历未筛选的全国岗位列表。");
  const initial = await fetchOfficial(entryUrl, fetchImpl);
  const unfiltered = extractPagination(initial.html);
  const operational = extractOperationalToken(initial.html);
  const firstUrl = buildFilteredUrl({ entryUrl: initial.finalUrl, operational, city, page: 1, rowSize });
  const first = await fetchOfficial(firstUrl, fetchImpl);
  const filtered = extractPagination(first.html);
  if (filtered.total >= unfiltered.total && unfiltered.total > 0) {
    throw new CollectionSafetyError(`官方地点筛选未生效（筛选后 ${filtered.total} 条，未筛选 ${unfiltered.total} 条），拒绝读取未筛选大列表。`);
  }
  const safePageLimit = allPages ? filtered.pages : Math.min(filtered.pages, Math.max(1, maxPages));
  const pageHtml = [first.html];
  const pagesVisited = [1];
  for (let page = 2; page <= safePageLimit; page += 1) {
    const next = await fetchOfficial(buildFilteredUrl({ entryUrl: initial.finalUrl, operational, city, page, rowSize }), fetchImpl);
    pageHtml.push(next.html);
    pagesVisited.push(page);
  }
  const deduplicated = new Map();
  for (const html of pageHtml) {
    for (const position of parsePositions(html, initial.finalUrl)) deduplicated.set(position.officialUrl, position);
  }
  return {
    sourceId: SOURCE_ID,
    collectionMethod: "script",
    collectedAt: new Date().toISOString(),
    runtime: { node: process.version, usesOnly: ["Node fetch", "Node URL", "Node fs"] },
    officialEntryUrl: entryUrl,
    nativeFilter: { workPlace: city, recruitType: "校园招聘（官方 recruitType=1）" },
    unfilteredTotal: unfiltered.total,
    filteredTotal: filtered.total,
    filteredPages: filtered.pages,
    pagesVisited,
    truncatedForDemo: !allPages && safePageLimit < filtered.pages,
    deduplicatedPositions: [...deduplicated.values()]
  };
}

export function summarizeCollection(result) {
  return {
    sourceId: result.sourceId,
    collectionMethod: result.collectionMethod,
    collectedAt: result.collectedAt,
    runtime: result.runtime,
    officialEntryUrl: result.officialEntryUrl,
    nativeFilter: result.nativeFilter,
    unfilteredTotal: result.unfilteredTotal,
    filteredTotal: result.filteredTotal,
    filteredPages: result.filteredPages,
    pagesVisited: result.pagesVisited,
    truncatedForDemo: result.truncatedForDemo,
    deduplicatedPositionCount: result.deduplicatedPositions.length,
    samplePositions: result.deduplicatedPositions.slice(0, 3).map(({ title, organization, location, officialUrl }) => ({ title, organization, location, officialUrl }))
  };
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function loadRuntimeConfig() {
  const root = new URL("../", import.meta.url);
  const [registryRaw, recipesRaw] = await Promise.all([
    readFile(new URL("data/source-registry.json", root), "utf8"),
    readFile(new URL("data/filter-recipes.json", root), "utf8")
  ]);
  const registry = JSON.parse(registryRaw);
  const recipes = JSON.parse(recipesRaw);
  const source = registry.sources.find((item) => item.id === SOURCE_ID);
  const recipe = recipes.recipes.find((item) => item.sourceId === SOURCE_ID);
  if (!source || recipe?.collection?.primary !== "script") {
    throw new CollectionSafetyError("当前仓库没有启用中国电信的脚本采集配方。");
  }
  return { city: recipes.city, entryUrl: source.entryUrl };
}

async function main() {
  const help = process.argv.includes("--help");
  if (help) {
    console.log("用法：node scripts/collect-chinatelecom.mjs [--city 城市] [--max-pages N] [--all-pages] [--summary]");
    return;
  }
  const config = await loadRuntimeConfig();
  const city = readArgument("--city") || config.city;
  const maxPages = Number(readArgument("--max-pages") || 3);
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new CollectionSafetyError("--max-pages 必须是正整数。");
  const output = await collectChinaTelecom({
    entryUrl: config.entryUrl,
    city,
    maxPages,
    allPages: process.argv.includes("--all-pages")
  });
  console.log(JSON.stringify(process.argv.includes("--summary") ? summarizeCollection(output) : output, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ sourceId: SOURCE_ID, status: "accessible-incomplete", error: error.message }, null, 2));
    process.exitCode = 1;
  });
}
