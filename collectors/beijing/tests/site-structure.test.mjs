import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pages = ["index.html", "monitors.html", "sources.html", "audit.html"];
const expectedNavigation = [
  ["index.html", "岗位"],
  ["monitors.html", "考试公告"],
  ["sources.html", "信息源"],
  ["audit.html", "更新记录"],
];

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("every page exposes the same four-page navigation", async () => {
  for (const page of pages) {
    const html = await read(page);
    for (const [href, label] of expectedNavigation) {
      assert.match(html, new RegExp(`<a[^>]+href="${href}"[^>]*>${label}</a>`), `${page} 缺少 ${label} 入口`);
    }
    assert.equal((html.match(/class="nav-current"/g) || []).length, 1, `${page} 应只有一个当前页标记`);
  }
});

test("pages version static assets so a refresh cannot reuse the previous layout", async () => {
  const scripts = {
    "index.html": "app.js",
    "monitors.html": "app.js",
    "sources.html": "sources.js",
    "audit.html": "audit.js",
  };
  for (const [page, script] of Object.entries(scripts)) {
    const html = await read(page);
    assert.match(html, /href="styles\.css\?v=\d{8}-\d{4}"/, `${page} 缺少样式版本号`);
    assert.match(html, new RegExp(`src="${script.replace(".", "\\.")}\\?v=\\d{8}-\\d{4}"`), `${page} 缺少脚本版本号`);
  }
});

test("favorites stay in the job list and the former page redirects", async () => {
  const [index, favorites, app] = await Promise.all([read("index.html"), read("favorites.html"), read("app.js")]);
  assert.match(index, /data-saved-filter/);
  assert.match(favorites, /index\.html\?saved=1#opportunities/);
  assert.match(app, /radar-saved-opportunities/);
  assert.match(app, /URLSearchParams\(location\.search\)/);
  for (const page of pages) assert.doesNotMatch(await read(page), /href="favorites\.html"/);
});

test("source cards retain meaningful overlap but reserve selection tags for its active collection chain", async () => {
  const [sourcesPage, sourcesScript, registryRaw] = await Promise.all([
    read("sources.html"), read("sources.js"), read("data/source-registry.json"),
  ]);
  const registry = JSON.parse(registryRaw);
  assert.match(sourcesPage, /不是四只互不相干的抽屉/);
  assert.match(sourcesPage, /招录方式/);
  assert.match(sourcesPage, /单位性质/);
  assert.match(sourcesScript, /source\.coverage/);
  assert.ok(registry.sources.every((source) => Array.isArray(source.coverage) && source.coverage.length > 0));
  const shared = registry.sources.find((source) => source.id === "beijing-personnel-exam");
  assert.deepEqual(shared.coverage, ["公务员招录", "事业单位", "国有企业"]);
  const selectionSources = registry.sources.filter((source) => source.coverage.includes("选调优培")).map((source) => source.id).sort();
  assert.deepEqual(selectionSources, ["beijing-selection-program", "buaa-career-discovery"]);
});

test("source directory separates user shortcuts from collection status", async () => {
  const [sourcesPage, sourcesScript] = await Promise.all([read("sources.html"), read("sources.js")]);
  assert.match(sourcesPage, /官方快捷入口/);
  assert.match(sourcesPage, /采集与核验路线/);
  assert.match(sourcesScript, /view: "shortcut"/);
  assert.match(sourcesScript, /不显示采集状态/);
  assert.match(sourcesScript, /collectionEntryUrl/);
  assert.match(sourcesScript, /未在最近更新中/);
});

test("each scheduled run covers every registered source instead of rotating source batches", async () => {
  const [registryRaw, planRaw] = await Promise.all([
    read("data/source-registry.json"),
    read("data/source-plan.json"),
  ]);
  const registry = JSON.parse(registryRaw);
  const plan = JSON.parse(planRaw);
  const officialIds = registry.sources.filter((source) => source.officialSiteConfirmed).map((source) => source.id).sort();
  const discoveryIds = registry.sources.filter((source) => source.role === "discovery").map((source) => source.id).sort();

  assert.equal(plan.version, 4);
  assert.deepEqual([...plan.coverage.everyRunOfficial].sort(), officialIds);
  assert.deepEqual([...plan.coverage.everyRunDiscovery].sort(), discoveryIds);
  assert.ok(registry.sources.every((source) => source.cadence === "every-run"));
  assert.equal(plan.coverage.morningRotation, undefined);
  assert.equal(plan.coverage.noonRotation, undefined);
});

test("automation treats validation failures as a repair loop instead of a stopping point", async () => {
  const [agents, automation, prompts] = await Promise.all([
    read("AGENTS.md"),
    read("AUTOMATION.md"),
    read("automation/task-prompts.md"),
  ]);
  assert.match(agents, /一次失败不是结束任务的理由/);
  assert.match(automation, /步骤 H：门禁修复循环/);
  assert.match(automation, /不得在首次失败后停止、暂停任务或等待下一次定时触发/);
  assert.match(prompts, /不得在第一次失败后暂停或把失败当作最终回执/);
});

test("public pages do not render internal processing notes", async () => {
  const [app, audit, sources, opportunitiesRaw] = await Promise.all([
    read("app.js"), read("audit.js"), read("sources.js"), read("data/opportunities.json"),
  ]);
  const opportunities = JSON.parse(opportunitiesRaw);
  const nationalMonitor = opportunities.monitors.find((monitor) => monitor.id === "national-civil-2027");
  assert.equal(nationalMonitor.status, "等待公告");
  assert.doesNotMatch(nationalMonitor.note, /报名系统|主入口|补充录用入口|下一轮/);
  assert.match(app, /查看官网/);
  assert.doesNotMatch(app, /statusEvidence/);
  assert.doesNotMatch(audit, /source\.note|source\.attempts|review\.verificationNote|review\.fallback|renderScreeningMetrics/);
  assert.doesNotMatch(sources, /source\.note|source\.attempts/);
});

test("national civil service monitor uses the two current official entries", async () => {
  const [registryRaw, opportunitiesRaw] = await Promise.all([
    read("data/source-registry.json"),
    read("data/opportunities.json"),
  ]);
  const registry = JSON.parse(registryRaw);
  const opportunities = JSON.parse(opportunitiesRaw);
  const source = registry.sources.find((item) => item.id === "national-civil");
  const monitor = opportunities.monitors.find((item) => item.id === "national-civil-2027");
  const main = "http://bm.scs.gov.cn/pp/gkweb/core/web/ui/business/home/gkhome.html";
  const supplementary = "http://subb.scs.gov.cn/pp/gkweb/core/web/ui/business/home/lxhome.html";

  assert.equal(source.entryUrl, main);
  assert.deepEqual(source.alternateEntryUrls, [supplementary]);
  assert.equal(source.transportSecurity, "official-http-only");
  assert.equal(monitor.officialUrl, main);
  assert.equal(monitor.alternateOfficialUrl, supplementary);
});

test("failed sources have explicit recovery routes and processing recipes", async () => {
  const [registryRaw, recipesRaw, planRaw] = await Promise.all([
    read("data/source-registry.json"),
    read("data/filter-recipes.json"),
    read("data/source-plan.json"),
  ]);
  const registry = JSON.parse(registryRaw);
  const recipes = JSON.parse(recipesRaw);
  const plan = JSON.parse(planRaw);
  const source = (id) => registry.sources.find((item) => item.id === id);
  const recipeIds = new Set(recipes.recipes.map((item) => item.sourceId));
  const repaired = [
    "china-public-recruitment", "central-sasac-recruitment", "sinopec-careers",
    "cmcc-careers", "chinatelecom-careers", "casic-careers",
    "spacechina-careers", "chinapost-recruitment",
  ];

  assert.equal(registry.version, 4);
  assert.equal(recipes.version, 3);
  for (const id of repaired) {
    assert.ok(source(id)?.accessMode, `${id} 缺少访问方式`);
    assert.ok(recipeIds.has(id), `${id} 缺少处理配方`);
  }
  assert.match(source("china-public-recruitment").alternateEntryUrls[0], /^http:\/\/job\.mohrss\.gov\.cn/);
  assert.match(source("central-sasac-recruitment").alternateEntryUrls[0], /^http:\/\/wap\.sasac\.gov\.cn/);
  assert.equal(source("chinatelecom-careers").entryUrl, "https://job.chinatelecom.com.cn/wt/TELE/web/index/campus");
  assert.equal(source("chinapost-recruitment").entryUrl, "https://www.chinapost.com.cn/");
  assert.deepEqual(source("casic-careers").semanticFailureSignals, ["/404?errorpath=", "Not Found"]);
  assert.equal(plan.sourceOutcomeDefinitions["accessible-incomplete"].includes("入口可用"), true);
  assert.equal(source("central-enterprise-roster").alternateEntryUrls[0], "http://wap.sasac.gov.cn/n2588045/n27271785/n27271792/c14159097/content.html");
  for (const id of ["national-civil", "central-enterprise-roster", "china-public-recruitment", "central-sasac-recruitment", "picc-campus", "sinopec-careers"]) {
    assert.match(recipes.recipes.find((item) => item.sourceId === id)?.availabilityRule || "", /官方页面|官方栏目|官方路径|官方来源|官方入口/);
  }
});

test("official major eligibility is the hard gate and job wording only affects ranking", async () => {
  const [agents, planRaw, policyRaw] = await Promise.all([
    read("AGENTS.md"), read("data/source-plan.json"), read("data/screening-policy.json"),
  ]);
  const plan = JSON.parse(planRaw);
  const policy = JSON.parse(policyRaw);
  assert.match(agents, /是否可报只依据官方/);
  assert.match(plan.profileRelevanceGate.publicDisplayRule, /纯计算机岗位还必须具有明确生物医学交叉场景/);
  assert.equal(policy.profileRelevanceGate.discoveryTermsAreNotPublicationEvidence, true);
  assert.equal(policy.profileRelevanceGate.roleTextNeverRejectsEligibleMajor, false);
  assert.equal(policy.profileRelevanceGate.pureComputingRequiresBiomedicalBridge, true);
});

test("future runs record endpoint evidence before declaring an official source unavailable", async () => {
  const [agents, automation, prompts, validator] = await Promise.all([
    read("AGENTS.md"), read("AUTOMATION.md"), read("automation/task-prompts.md"), read("scripts/validate-review-log.mjs"),
  ]);
  for (const content of [agents, automation, prompts]) {
    assert.match(content, /accessEvidence/);
    assert.match(content, /accessible-incomplete/);
  }
  assert.match(prompts, /policyVersion 6/);
  assert.match(validator, /已 有可用官方页面|已有可用官方页面/);
  assert.match(validator, /不能写 temporarily-unavailable/);
});

test("BUAA job board is a high-priority discovery source, not public publication evidence", async () => {
  const [registryRaw, planRaw, recipesRaw] = await Promise.all([
    read("data/source-registry.json"), read("data/source-plan.json"), read("data/filter-recipes.json"),
  ]);
  const registry = JSON.parse(registryRaw);
  const plan = JSON.parse(planRaw);
  const recipes = JSON.parse(recipesRaw);
  const source = registry.sources.find((item) => item.id === "buaa-career-discovery");
  const recipe = recipes.recipes.find((item) => item.sourceId === "buaa-career-discovery");
  assert.equal(source.role, "discovery");
  assert.equal(source.tier, "priority");
  assert.equal(source.officialSiteConfirmed, false);
  assert.ok(plan.coverage.everyRunDiscovery.includes(source.id));
  assert.match(recipe.queryPlan.completionRule, /不作为正文岗位或公告的发布证据/);
});

test("top bar shows only the update time while audit uses user-facing update language", async () => {
  const [opportunitiesRaw, reviewLogRaw, app, audit] = await Promise.all([
    read("data/opportunities.json"), read("data/review-log.json"), read("app.js"), read("audit.js"),
  ]);
  const opportunities = JSON.parse(opportunitiesRaw);
  const latestRun = JSON.parse(reviewLogRaw).runs[0];
  assert.equal(opportunities.meta.lastIncompleteSourceCount, latestRun.metrics.officialSystemsFailed);
  assert.equal(opportunities.meta.lastDeferredCandidateCount, latestRun.screeningMetrics.positionsDeferredByBudget);
  assert.match(app, /最近更新：/);
  assert.match(audit, /最近更新：/);
  assert.match(audit, /部分信息仍待确认/);
  assert.doesNotMatch(`${app}\n${audit}`, /上次未查完|候选待处理|部分网站未完成|部分网站没查完|个来源未完成/);
});

test("removed template-like slogans do not return", async () => {
  const content = (await Promise.all([...pages, "app.js", "audit.js"].map(read))).join("\n");
  for (const phrase of ["某单位在招", "线索可以很杂", "公开数据必须很干净"]) {
    assert.doesNotMatch(content, new RegExp(phrase));
  }
});

test("homepage makes the biomedical-master selection scope explicit without exposing personal details", async () => {
  const index = await read("index.html");
  assert.match(index, /主要面向生物医学相关背景的硕士/);
  assert.match(index, /生物医学工程及相近工科背景的硕士/);
  assert.match(index, /公考逐项确认条件/);
  assert.match(index, /北京优先，官网为准/);
  assert.match(index, /页面不保存姓名、学校或联系方式/);
});
