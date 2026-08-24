import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [targetArgument, cityKey] = process.argv.slice(2);

const cities = {
  shanghai: {
    name: "上海", municipality: "上海市", slug: "shanghai", abbreviation: "SH", civilExam: "沪考",
    civil: {
      id: "shanghai-civil", organization: "上海市公务员局", domains: ["shacs.gov.cn"],
      entryUrl: "https://www.shacs.gov.cn/", alternateEntryUrls: ["https://files.shacs.gov.cn/"],
      coverage: ["公务员招录", "选调优培"],
    },
    personnel: {
      id: "shanghai-personnel-exam", organization: "上海市人力资源和社会保障局人事考试与招聘", domains: ["rsj.sh.gov.cn"],
      entryUrl: "https://rsj.sh.gov.cn/", coverage: ["公务员招录", "选调优培", "事业单位"],
    },
    institutions: {
      id: "shanghai-institutions", organization: "上海市人力资源和社会保障局事业单位招聘", domains: ["rsj.sh.gov.cn"],
      entryUrl: "https://rsj.sh.gov.cn/tsydwgkzp_17406/index.html", coverage: ["事业单位"],
    },
    stateAssets: {
      id: "shanghai-state-assets", organization: "上海市国资委国企招聘", domains: ["gzw.sh.gov.cn"],
      entryUrl: "https://www.gzw.sh.gov.cn/shgzw_xxgk_cqzp/index.html", coverage: ["国有企业"],
    },
  },
  guangzhou: {
    name: "广州", municipality: "广州市", slug: "guangzhou", abbreviation: "GZ", civilExam: "粤考",
    civil: {
      id: "guangzhou-civil", organization: "广东省公务员考试录用管理系统（广州职位）", domains: ["ggfw.hrss.gd.gov.cn"],
      entryUrl: "https://ggfw.hrss.gd.gov.cn/gwyks/anouns.do", alternateEntryUrls: ["https://ggfw.hrss.gd.gov.cn/gwyks/index.do"],
      coverage: ["公务员招录", "选调优培"],
    },
    personnel: {
      id: "guangzhou-personnel-exam", organization: "广州市人力资源和社会保障局人事考试与招聘", domains: ["rsj.gz.gov.cn"],
      entryUrl: "https://rsj.gz.gov.cn/", coverage: ["公务员招录", "选调优培", "事业单位"],
    },
    institutions: {
      id: "guangzhou-institutions", organization: "广州市人力资源和社会保障局事业单位公开招聘", domains: ["rsj.gz.gov.cn"],
      entryUrl: "https://rsj.gz.gov.cn/ywzt/rszdgg/sydwgkzp/index.html", coverage: ["事业单位"],
    },
    stateAssets: {
      id: "guangzhou-state-assets", organization: "广州市国资委国企招聘", domains: ["gzw.gz.gov.cn"],
      entryUrl: "https://gzw.gz.gov.cn/", coverage: ["国有企业"],
    },
  },
  shenzhen: {
    name: "深圳", municipality: "深圳市", slug: "shenzhen", abbreviation: "SZ", civilExam: "粤考",
    civil: {
      id: "shenzhen-civil", organization: "广东省公务员考试录用管理系统（深圳职位）", domains: ["ggfw.hrss.gd.gov.cn"],
      entryUrl: "https://ggfw.hrss.gd.gov.cn/gwyks/anouns.do", alternateEntryUrls: ["https://ggfw.hrss.gd.gov.cn/gwyks/index.do"],
      coverage: ["公务员招录", "选调优培"],
    },
    personnel: {
      id: "shenzhen-personnel-exam", organization: "深圳市人力资源和社会保障局公职人员招考", domains: ["hrss.sz.gov.cn"],
      entryUrl: "https://hrss.sz.gov.cn/gzryzk/index.html", coverage: ["公务员招录", "选调优培", "事业单位"],
    },
    institutions: {
      id: "shenzhen-institutions", organization: "深圳市人力资源和社会保障局事业单位招聘", domains: ["hrss.sz.gov.cn"],
      entryUrl: "https://hrss.sz.gov.cn/gzryzk/index.html", coverage: ["事业单位"],
    },
    stateAssets: {
      id: "shenzhen-state-assets", organization: "深圳市国资委校园招聘", domains: ["gzw.sz.gov.cn"],
      entryUrl: "https://gzw.sz.gov.cn/xyzp/index.html", coverage: ["国有企业"],
    },
  },
};

if (!targetArgument || !cities[cityKey]) {
  console.error("用法：node scripts/bootstrap-city-site.mjs <目标仓库目录> <shanghai|guangzhou|shenzhen>");
  process.exit(1);
}

const root = resolve(targetArgument);
const city = cities[cityKey];
const hubUrl = "https://hoco-scy.github.io/city-opportunity-radar/";

const read = async (path) => readFile(resolve(root, path), "utf8");
const write = async (path, content) => writeFile(resolve(root, path), content);
const readJson = async (path) => JSON.parse(await read(path));
const writeJson = async (path, value) => write(path, `${JSON.stringify(value, null, 2)}\n`);

function cityText(value) {
  return value
    .replaceAll("北京市", city.municipality)
    .replaceAll("北京", city.name)
    .replaceAll("京考", city.civilExam)
    .replaceAll("beijing", city.slug)
    .replaceAll("BJ", city.abbreviation)
    .replaceAll(`${city.name}时间`, "北京时间");
}

const textFiles = [
  "AGENTS.md", "AUTOMATION.md", "README.md", "app.js", "audit.js", "index.html", "monitors.html",
  "sources.html", "audit.html", "favorites.html", "data/source-plan.json", "data/screening-policy.json",
  "data/filter-recipes.json", "automation/task-prompts.md",
];

for (const path of textFiles) await write(path, cityText(await read(path)));

for (const path of ["index.html", "monitors.html", "sources.html", "audit.html"]) {
  const html = await read(path);
  await write(path, html.replace("</nav>", `<a class="city-switch" href="${hubUrl}">切换城市</a></nav>`));
}

const styles = await read("styles.css");
await write("styles.css", styles.replace(
  ".topbar nav a.nav-current { color: var(--green); font-weight: 800; }",
  ".topbar nav a.nav-current { color: var(--green); font-weight: 800; }\n.topbar nav a.city-switch { padding: 7px 10px; border: 1px solid var(--line); border-radius: 99px; color: var(--green); font-size: 12px; font-weight: 700; }\n.topbar nav a.city-switch:hover { border-color: var(--green); background: var(--green-light); }"
));

const registry = await readJson("data/source-registry.json");
const localSourceMap = new Map([
  ["beijing-civil", city.civil],
  ["beijing-personnel-exam", city.personnel],
  ["beijing-institutions", city.institutions],
  ["beijing-state-assets", city.stateAssets],
]);
registry.sources = registry.sources.map((source) => {
  const local = localSourceMap.get(source.id);
  if (!local) return source;
  return {
    ...source,
    id: local.id,
    organization: local.organization,
    domains: local.domains,
    entryUrl: local.entryUrl,
    ...(local.alternateEntryUrls ? { alternateEntryUrls: local.alternateEntryUrls } : { alternateEntryUrls: undefined }),
    coverage: local.coverage,
  };
});
for (const source of registry.sources) {
  if (source.alternateEntryUrls === undefined) delete source.alternateEntryUrls;
}
await writeJson("data/source-registry.json", registry);

const opportunities = {
  meta: {
    schemaVersion: 1,
    initializationStatus: "awaiting-first-sync",
    lastVerifiedAt: null,
    lastRunStatus: "not-started",
    lastIncompleteSourceCount: 0,
    lastDeferredCandidateCount: 0,
    timezone: "Asia/Shanghai",
    publicationRule: "仅发布能在官方公告、职位表或官方招聘系统中定位到的具体岗位；公考岗位还必须通过全部个人资格硬条件",
  },
  jobs: [],
  monitors: [],
};
const reviewLog = {
  meta: {
    schemaVersion: 1,
    initializationStatus: "awaiting-first-sync",
    lastRunAt: null,
    timezone: "Asia/Shanghai",
    privacyRule: "只记录公开招聘事实、匿名审核结论和公开安全原因；不记录或反推任何私人资格字段",
  },
  runs: [],
};
await writeJson("data/opportunities.json", opportunities);
await writeJson("data/review-log.json", reviewLog);
await writeJson("data/radar-city.json", {
  version: 1,
  city: city.name,
  municipality: city.municipality,
  slug: city.slug,
  abbreviation: city.abbreviation,
  civilExam: city.civilExam,
  hubUrl,
  screeningScope: "生物医学工程及相近工科背景的硕士",
  localSourceIds: [city.civil.id, city.personnel.id, city.institutions.id, city.stateAssets.id],
});

let app = await read("app.js");
app = app.replace(
  '  grid.innerHTML = state.data.monitors.map((monitor) => {',
  '  if (!state.data.monitors.length) {\n    grid.innerHTML = `<div class="empty-state"><strong>等待首次完整更新</strong><p>公告和职位表会在完成官网核验后显示。</p></div>`;\n    return;\n  }\n  grid.innerHTML = state.data.monitors.map((monitor) => {'
).replace(
  'if (syncDate) syncDate.innerHTML = `<i></i>最近更新：${formatDateTime(meta.lastVerifiedAt)}`;',
  'if (syncDate) syncDate.innerHTML = meta.initializationStatus === "awaiting-first-sync"\n    ? `<i></i>等待首次完整更新`\n    : `<i></i>最近更新：${formatDateTime(meta.lastVerifiedAt)}`;'
);
await write("app.js", app);

let sources = await read("sources.js");
sources = sources.replace(
  'document.querySelector("#sync-date").innerHTML = `<i></i>最近更新：${formatDateTime(sourceState.reviewLog.meta.lastRunAt)}`;',
  'document.querySelector("#sync-date").innerHTML = sourceState.reviewLog.meta.initializationStatus === "awaiting-first-sync"\n      ? `<i></i>等待首次完整更新`\n      : `<i></i>最近更新：${formatDateTime(sourceState.reviewLog.meta.lastRunAt)}`;'
).replace(
  'const checkedAt = check?.checkedAt ? `最近更新 ${formatDateTime(check.checkedAt)}` : "持续关注招聘信息";',
  'const checkedAt = check?.checkedAt ? `最近更新 ${formatDateTime(check.checkedAt)}`\n      : sourceState.reviewLog.meta.initializationStatus === "awaiting-first-sync" ? "等待首次完整更新" : "持续关注招聘信息";'
);
await write("sources.js", sources);

let audit = await read("audit.js");
audit = audit.replace(
  'const runStatusLabels = { completed: "本次更新", "completed-partial": "部分信息待确认", failed: "暂无更新" };',
  'const runStatusLabels = { completed: "本次更新", "completed-partial": "部分信息待确认", failed: "暂无更新", "not-started": "等待首次更新" };'
).replace(
  'function render() {\n  const latest = auditState.data.runs[0];',
  'function render() {\n  if (!auditState.data.runs.length) {\n    document.querySelector("#sync-date").innerHTML = `<i></i>等待首次完整更新`;\n    document.querySelector("#latest-run").textContent = "尚未开始";\n    document.querySelector("#latest-reviewed").textContent = "—";\n    document.querySelector("#latest-published").textContent = "—";\n    document.querySelector("#audit-run-list").innerHTML = `<div class="empty-state"><strong>等待首次完整更新</strong><p>完成官网核验后，这里会留下每次处理和审核的记录。</p></div>`;\n    return;\n  }\n  const latest = auditState.data.runs[0];'
);
await write("audit.js", audit);

let validateData = await read("scripts/validate-data.mjs");
validateData = validateData.replace(
  'const runStatuses = new Set(["completed", "completed-partial", "failed"]);',
  'const runStatuses = new Set(["completed", "completed-partial", "failed", "not-started"]);'
).replace(
  'if (data.meta?.schemaVersion !== 1) errors.push("meta.schemaVersion 必须为 1");\nif (!minuteTimestamp.test(data.meta?.lastVerifiedAt || "")) errors.push("meta.lastVerifiedAt 必须是精确到分钟的北京时间，例如 2026-08-22T08:03:00+08:00");\nif (!runStatuses.has(data.meta?.lastRunStatus)) errors.push("meta.lastRunStatus 必须是 completed、completed-partial 或 failed");',
  'const awaitingFirstSync = data.meta?.initializationStatus === "awaiting-first-sync";\nif (data.meta?.schemaVersion !== 1) errors.push("meta.schemaVersion 必须为 1");\nif (awaitingFirstSync) {\n  if (data.meta?.lastVerifiedAt !== null) errors.push("首次同步前 lastVerifiedAt 必须为 null");\n  if (data.meta?.lastRunStatus !== "not-started") errors.push("首次同步前 lastRunStatus 必须为 not-started");\n} else {\n  if (!minuteTimestamp.test(data.meta?.lastVerifiedAt || "")) errors.push("meta.lastVerifiedAt 必须是精确到分钟的北京时间，例如 2026-08-22T08:03:00+08:00");\n  if (!runStatuses.has(data.meta?.lastRunStatus) || data.meta?.lastRunStatus === "not-started") errors.push("meta.lastRunStatus 必须是 completed、completed-partial 或 failed");\n}'
);
await write("scripts/validate-data.mjs", validateData);

let validateLog = await read("scripts/validate-review-log.mjs");
validateLog = validateLog.replace(
  'const runStatuses = new Set(["completed", "completed-partial", "failed"]);',
  'const runStatuses = new Set(["completed", "completed-partial", "failed", "not-started"]);'
).replace(
  'if (log.meta?.schemaVersion !== 1) errors.push("review-log meta.schemaVersion 必须为 1");\nif (!minuteTimestamp.test(log.meta?.lastRunAt || "")) errors.push("review-log meta.lastRunAt 必须精确到北京时间分钟");\nif (log.meta?.lastRunAt !== opportunities.meta?.lastVerifiedAt) errors.push("最近核验时间与审核日志最后运行时间不一致");\nif (!Array.isArray(log.runs) || !log.runs.length) errors.push("review-log.runs 至少需要一轮记录");\nif (log.runs?.[0]?.checkedAt !== log.meta?.lastRunAt) errors.push("最新一轮日志必须与 meta.lastRunAt 一致并排在首位");',
  'const awaitingFirstSync = log.meta?.initializationStatus === "awaiting-first-sync";\nif (log.meta?.schemaVersion !== 1) errors.push("review-log meta.schemaVersion 必须为 1");\nif (awaitingFirstSync) {\n  if (log.meta?.lastRunAt !== null || opportunities.meta?.lastVerifiedAt !== null) errors.push("首次同步前不得伪造核验时间");\n  if (opportunities.meta?.initializationStatus !== "awaiting-first-sync") errors.push("两个数据文件必须一致标记首次同步状态");\n  if (!Array.isArray(log.runs) || log.runs.length) errors.push("首次同步前不应生成审核运行记录");\n} else {\n  if (!minuteTimestamp.test(log.meta?.lastRunAt || "")) errors.push("review-log meta.lastRunAt 必须精确到北京时间分钟");\n  if (log.meta?.lastRunAt !== opportunities.meta?.lastVerifiedAt) errors.push("最近核验时间与审核日志最后运行时间不一致");\n  if (!Array.isArray(log.runs) || !log.runs.length) errors.push("review-log.runs 至少需要一轮记录");\n  if (log.runs?.[0]?.checkedAt !== log.meta?.lastRunAt) errors.push("最新一轮日志必须与 meta.lastRunAt 一致并排在首位");\n}'
);
await write("scripts/validate-review-log.mjs", validateLog);

await write("tests/site-structure.test.mjs", `import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pages = ["index.html", "monitors.html", "sources.html", "audit.html"];
const expectedNavigation = [["index.html", "岗位"], ["monitors.html", "考试公告"], ["sources.html", "信息源"], ["audit.html", "更新记录"]];
const read = (path) => readFile(new URL(\`../\${path}\`, import.meta.url), "utf8");
const city = JSON.parse(await read("data/radar-city.json"));

test("每个页面保留一致的四页导航和城市入口", async () => {
  for (const page of pages) {
    const html = await read(page);
    for (const [href, label] of expectedNavigation) assert.match(html, new RegExp(\`<a[^>]+href="\${href}"[^>]*>\${label}</a>\`));
    assert.match(html, new RegExp(\`href="\${city.hubUrl}"[^>]*>切换城市</a>\`));
    assert.equal((html.match(/class="nav-current"/g) || []).length, 1);
  }
});

test("静态资源有版本号，收藏仍留在岗位页", async () => {
  const [index, favorites, app] = await Promise.all([read("index.html"), read("favorites.html"), read("app.js")]);
  assert.match(index, /data-saved-filter/);
  assert.match(favorites, /index\\.html\\?saved=1#opportunities/);
  assert.match(app, /radar-saved-opportunities/);
  for (const page of pages) assert.match(await read(page), /styles\\.css\\?v=\\d{8}-\\d{4}/);
});

test("来源计划每轮覆盖全部登记来源", async () => {
  const [registryRaw, planRaw] = await Promise.all([read("data/source-registry.json"), read("data/source-plan.json")]);
  const registry = JSON.parse(registryRaw); const plan = JSON.parse(planRaw);
  const official = registry.sources.filter((source) => source.officialSiteConfirmed).map((source) => source.id).sort();
  const discovery = registry.sources.filter((source) => source.role === "discovery").map((source) => source.id).sort();
  assert.deepEqual([...plan.coverage.everyRunOfficial].sort(), official);
  assert.deepEqual([...plan.coverage.everyRunDiscovery].sort(), discovery);
  assert.ok(registry.sources.every((source) => source.cadence === "every-run"));
});

test("首次同步前不伪造核验时间或岗位", async () => {
  const [dataRaw, logRaw] = await Promise.all([read("data/opportunities.json"), read("data/review-log.json")]);
  const data = JSON.parse(dataRaw); const log = JSON.parse(logRaw);
  assert.equal(data.meta.initializationStatus, "awaiting-first-sync");
  assert.equal(data.meta.lastVerifiedAt, null);
  assert.equal(data.meta.lastRunStatus, "not-started");
  assert.deepEqual(data.jobs, []);
  assert.deepEqual(log.runs, []);
});

test("城市范围保持生物医学硕士筛选与匿名边界", async () => {
  const [index, agents, automation] = await Promise.all([read("index.html"), read("AGENTS.md"), read("AUTOMATION.md")]);
  assert.match(index, /主要面向生物医学相关背景的硕士/);
  assert.match(index, new RegExp(\`${city.name}优先，官网为准\`));
  assert.match(index, /页面不保存姓名、学校或联系方式/);
  assert.match(agents, /公考、/);
  assert.match(automation, /私有资格档案只用于资格判断/);
});

test("失败来源必须有恢复策略，普通更新必须修复门禁", async () => {
  const [registryRaw, recipesRaw, automation, prompts] = await Promise.all([read("data/source-registry.json"), read("data/filter-recipes.json"), read("AUTOMATION.md"), read("automation/task-prompts.md")]);
  const registry = JSON.parse(registryRaw); const recipes = JSON.parse(recipesRaw);
  const ids = new Set(recipes.recipes.map((recipe) => recipe.sourceId));
  for (const source of registry.sources.filter((source) => source.recipeRequired)) assert.ok(ids.has(source.id));
  assert.match(automation, /步骤 H：门禁修复循环/);
  assert.match(prompts, /不得在第一次失败后暂停或把失败当作最终回执/);
});
`);

console.log(`已初始化 ${city.name} 求职雷达：等待首次完整同步，未复制北京岗位或审核结论。`);
