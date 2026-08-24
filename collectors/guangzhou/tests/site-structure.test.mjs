import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pages = ["index.html", "monitors.html", "sources.html", "audit.html"];
const expectedNavigation = [["index.html", "岗位"], ["monitors.html", "考试公告"], ["sources.html", "信息源"], ["audit.html", "更新记录"]];
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const city = JSON.parse(await read("data/radar-city.json"));

test("每个页面保留一致的四页导航和城市入口", async () => {
  for (const page of pages) {
    const html = await read(page);
    for (const [href, label] of expectedNavigation) assert.match(html, new RegExp(`<a[^>]+href="${href}"[^>]*>${label}</a>`));
    assert.match(html, new RegExp(`href="${city.hubUrl}"[^>]*>切换城市</a>`));
    assert.equal((html.match(/class="nav-current"/g) || []).length, 1);
  }
});

test("静态资源有版本号，收藏仍留在岗位页", async () => {
  const [index, favorites, app] = await Promise.all([read("index.html"), read("favorites.html"), read("app.js")]);
  assert.match(index, /data-saved-filter/);
  assert.match(favorites, /index\.html\?saved=1#opportunities/);
  assert.match(app, /radar-saved-opportunities/);
  for (const page of pages) assert.match(await read(page), /styles\.css\?v=\d{8}-\d{4}/);
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

test("首轮同步状态与数据保持一致", async () => {
  const [dataRaw, logRaw] = await Promise.all([read("data/opportunities.json"), read("data/review-log.json")]);
  const data = JSON.parse(dataRaw); const log = JSON.parse(logRaw);
  if (data.meta.initializationStatus === "awaiting-first-sync") {
    assert.equal(data.meta.lastVerifiedAt, null);
    assert.equal(data.meta.lastRunStatus, "not-started");
    assert.deepEqual(log.runs, []);
    assert.deepEqual(data.jobs, []);
  } else {
    assert.equal(data.meta.initializationStatus, "synchronized");
    assert.match(data.meta.lastVerifiedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/);
    assert.notEqual(data.meta.lastRunStatus, "not-started");
    assert.ok(log.runs.length >= 1);
    assert.equal(log.meta.lastRunAt, data.meta.lastVerifiedAt);
    assert.ok(Array.isArray(data.jobs));
  }
});

test("城市范围保持生物医学硕士筛选与匿名边界", async () => {
  const [index, agents, automation] = await Promise.all([read("index.html"), read("AGENTS.md"), read("AUTOMATION.md")]);
  assert.match(index, /主要面向生物医学相关背景的硕士/);
  assert.match(index, new RegExp(`广州优先，官网为准`));
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
