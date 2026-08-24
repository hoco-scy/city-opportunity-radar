import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createRadarServer } from "../server.mjs";
import { importLegacyCities } from "../scripts/import-legacy-cities.mjs";
import { isPubliclyDisplayableOpportunity } from "../db.mjs";

const projectRoot = resolve(new URL("../", import.meta.url).pathname);
const legacyRoot = resolve(projectRoot, "..");
const validCode = `mlr_${"a".repeat(64)}`;

async function request(base, path, options) {
  const response = await fetch(`${base}${path}`, options);
  return { response, body: await response.json() };
}

test("only publishes enterprise and institution roles with official professional and role evidence", () => {
  assert.equal(isPubliclyDisplayableOpportunity({
    track: "央国企", title: "信息化咨询工程师", majors: "专业不限", responsibilities: ["开展政府信息化咨询"],
  }), false);
  assert.equal(isPubliclyDisplayableOpportunity({
    track: "事业单位", title: "医学影像设备工程师", majors: "生物医学工程、医学工程相关专业", responsibilities: ["负责医学影像设备临床应用支持"],
  }), true);
  assert.equal(isPubliclyDisplayableOpportunity({ track: "考公", title: "已通过资格门禁的岗位" }), true);
});

test("imports all four cities and exposes the unified public API", async (t) => {
  const workdir = await mkdtemp(join(tmpdir(), "menglin-radar-"));
  const databasePath = join(workdir, "radar.sqlite");
  t.after(async () => rm(workdir, { recursive: true, force: true }));

  const summary = await importLegacyCities({ legacyRoot, databasePath });
  assert.equal(summary.length, 4);
  assert.deepEqual(summary.map((item) => item.cityId), ["beijing", "shanghai", "guangzhou", "shenzhen"]);
  assert.ok(summary.every((item) => item.sources >= 27));

  let syncCalls = 0;
  const { server, db } = createRadarServer({
    databasePath,
    bootstrapAdmin: { username: "menglin-admin", password: "test-only-admin-password" },
    syncRunner: async () => {
      syncCalls += 1;
      return { importedCityCount: 4, failedCityCount: 0, outcomes: [], imported: [], completedAt: new Date().toISOString() };
    },
  });
  t.after(() => { db.close(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const health = await request(base, "/api/health");
  assert.equal(health.response.status, 200);
  assert.deepEqual(health.body, { ok: true, database: "sqlite", cities: 4 });

  const adminStatus = await request(base, "/api/admin/status");
  assert.equal(adminStatus.response.status, 200);
  assert.equal(adminStatus.body.configured, true);

  const cities = await request(base, "/api/cities");
  assert.equal(cities.response.status, 200);
  assert.equal(cities.body.cities.length, 4);
  assert.equal(cities.body.cities[0].id, "beijing");
  assert.ok(cities.body.cities.every((city) => city.name));

  const jobs = await request(base, "/api/cities/beijing/opportunities?track=%E5%A4%AE%E5%9B%BD%E4%BC%81");
  assert.equal(jobs.response.status, 200);
  assert.ok(jobs.body.opportunities.every((item) => item.track === "央国企"));
  assert.ok(jobs.body.opportunities.every(isPubliclyDisplayableOpportunity));

  const announcements = await request(base, "/api/cities/beijing/opportunities?kind=monitor");
  assert.equal(announcements.response.status, 200);
  assert.equal(announcements.body.opportunities.length, 5);
  assert.ok(announcements.body.opportunities.every((item) => item.note));

  const candidates = await request(base, "/api/cities/beijing/opportunities?kind=candidate");
  assert.equal(candidates.response.status, 200);
  assert.ok(candidates.body.opportunities.every((item) => item.status === "待用户确认"));
  assert.ok(candidates.body.opportunities.every((item) => item.manualConfirmationRequired === true));

  const adminLogin = await request(base, "/api/admin/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "menglin-admin", password: "test-only-admin-password" }),
  });
  assert.equal(adminLogin.response.status, 201);
  assert.match(adminLogin.body.token, /^mas_/);
  const adminHeaders = { "x-radar-admin-session": adminLogin.body.token, "content-type": "application/json" };

  const candidate = candidates.body.opportunities[0];
  const reviewed = await request(base, "/api/admin/candidate-reviews", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      cityId: "beijing",
      candidateId: candidate.id,
      decision: "approved",
      details: {
        track: "央国企",
        officialAnnouncementUrl: "https://careers.example.gov.cn/notice/1",
        officialApplyUrl: "https://careers.example.gov.cn/apply/1",
        exactTitle: "医学影像设备工程师",
        organization: "某中央企业健康科技单位",
        location: "北京",
        deadline: "2026-12-31",
        education: "硕士研究生及以上",
        majors: "生物医学工程、医学工程相关专业",
        responsibilities: "负责医学影像设备临床应用支持\n参与医疗器械测试验证",
        requirements: "2027 年应届毕业生\n符合岗位其他资格条件",
        status: "招聘中",
        priority: 88,
        matchReason: "官方岗位原文明确面向生物医学工程相关硕士，职责与医学影像设备临床应用直接相关。",
        note: "测试：已核对公告、岗位要求与投递页。",
        activeConfirmed: true,
      },
    }),
  });
  assert.equal(reviewed.response.status, 200);
  assert.equal(reviewed.body.decision, "approved");
  assert.equal(reviewed.body.opportunity.track, "央国企");

  const candidatesAfterReview = await request(base, "/api/cities/beijing/opportunities?kind=candidate");
  assert.ok(!candidatesAfterReview.body.opportunities.some((item) => item.id === candidate.id));
  const reviewedJobs = await request(base, "/api/cities/beijing/opportunities?q=%E5%8C%BB%E5%AD%A6%E5%BD%B1%E5%83%8F%E8%AE%BE%E5%A4%87");
  assert.ok(reviewedJobs.body.opportunities.some((item) => item.id === reviewed.body.opportunity.id));

  // A later import replaces collector snapshots, but does not erase an
  // administrator's decision or put the same candidate back into the queue.
  await importLegacyCities({ legacyRoot, databasePath, cityIds: ["beijing"] });
  const candidatesAfterImport = await request(base, "/api/cities/beijing/opportunities?kind=candidate");
  assert.ok(!candidatesAfterImport.body.opportunities.some((item) => item.id === candidate.id));
  const preservedJob = await request(base, "/api/cities/beijing/opportunities?q=%E5%8C%BB%E5%AD%A6%E5%BD%B1%E5%83%8F%E8%AE%BE%E5%A4%87");
  assert.ok(preservedJob.body.opportunities.some((item) => item.id === reviewed.body.opportunity.id));

  const syncStart = await request(base, "/api/admin/sync", { method: "POST", headers: adminHeaders, body: "{}" });
  assert.equal(syncStart.response.status, 202);
  await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  const syncStatus = await request(base, "/api/admin/sync", { headers: adminHeaders });
  assert.equal(syncStatus.body.state, "completed");
  assert.equal(syncCalls, 1);

  const shortcuts = await request(base, "/api/cities/beijing/sources?view=shortcut");
  assert.ok(shortcuts.body.sources.length > 0);
  assert.ok(shortcuts.body.sources.every((item) => item.entryUrl));
  assert.ok(shortcuts.body.sources.every((item) => !Object.hasOwn(item, "latestCheck")));
  for (const sourceId of ["picc-campus", "crc-careers", "casic-careers", "spacechina-careers"]) {
    assert.ok(shortcuts.body.sources.some((item) => item.id === sourceId));
  }
  for (const sourceId of ["cec-campus", "cetc-recruitment", "sgcc-careers", "cnpc-careers", "sinopec-careers", "cmcc-careers", "chinatelecom-careers", "chinapost-recruitment"]) {
    assert.ok(!shortcuts.body.sources.some((item) => item.id === sourceId));
  }

  const collection = await request(base, "/api/cities/beijing/sources?view=collection");
  assert.ok(collection.body.sources.length > 0);
  assert.ok(collection.body.sources.every((item) => item.collectionEntryUrl));
  assert.ok(collection.body.sources.every((item) => item.collectionMethod));
  assert.ok(collection.body.sources.every((item) => !/待登记/.test(item.collectionMethod)));
  const beijingSelection = collection.body.sources.find((item) => item.id === "beijing-selection-program");
  assert.equal(beijingSelection.organization, "北航就业信息网（公务员／选调生）");
  assert.match(beijingSelection.collectionEntryUrl, /^https:\/\/career\.buaa\.edu\.cn\//);
  assert.equal(collection.body.sources.find((item) => item.id === "buaa-career-discovery")?.collectionMethod, "北航公开筛选脚本（待用户确认线索）");
  assert.equal(collection.body.sources.find((item) => item.id === "iguopin-discovery")?.collectionMethod, "国聘公开筛选脚本（待用户确认线索）");
  assert.equal(collection.body.sources.find((item) => item.id === "national-college-employment")?.collectionMethod, "国家大学生就业服务平台公开筛选脚本（待用户确认线索）");
  for (const cityId of ["shanghai", "guangzhou", "shenzhen"]) {
    const cityCollection = await request(base, `/api/cities/${cityId}/sources?view=collection`);
    const selection = cityCollection.body.sources.find((item) => item.id === `${cityId}-selection-program`);
    assert.equal(selection.organization, "北航就业信息网（公务员／选调生）");
    assert.match(selection.collectionEntryUrl, /^https:\/\/career\.buaa\.edu\.cn\//);
  }
  assert.ok(collection.body.sources.some((item) => item.latestCheck));
  assert.ok(collection.body.sources.some((item) => item.latestCheck?.isCurrent));
  assert.ok(collection.body.sources.every((item) => item.latestCheck?.collectionMetrics));
  for (const item of collection.body.sources) {
    const metrics = item.latestCheck.collectionMetrics;
    assert.ok(["completed", "partial", "not-completed", "unavailable"].includes(metrics.state));
    if (["completed", "partial"].includes(metrics.state)) {
      assert.ok(Number.isInteger(metrics.collected) && metrics.collected >= 0);
      assert.ok(Number.isInteger(metrics.afterFilter) && metrics.afterFilter >= 0 && metrics.afterFilter <= metrics.collected);
    } else {
      assert.equal(metrics.collected, null);
      assert.equal(metrics.afterFilter, null);
    }
  }
  assert.ok(!collection.body.sources.some((item) => item.id === "chinatelecom-careers"));

  const denied = await request(base, "/api/favorites");
  assert.equal(denied.response.status, 401);

  const job = announcements.body.opportunities[0];
  const favoriteHeaders = { "x-radar-user-code": validCode, "content-type": "application/json" };
  const saved = await request(base, "/api/favorites", { method: "POST", headers: favoriteHeaders, body: JSON.stringify({ cityId: "beijing", opportunityId: job.id }) });
  assert.equal(saved.response.status, 201);
  assert.deepEqual(saved.body.favorites.map((item) => [item.cityId, item.opportunityId]), [["beijing", job.id]]);

  const removed = await request(base, "/api/favorites", { method: "DELETE", headers: favoriteHeaders, body: JSON.stringify({ cityId: "beijing", opportunityId: job.id }) });
  assert.equal(removed.response.status, 200);
  assert.equal(removed.body.favorites.length, 0);

  for (const [pathname, expectedTitle] of [["/", /岗位｜梦琳求职雷达/], ["/announcements.html", /考试公告｜梦琳求职雷达/], ["/sources.html", /信息源｜梦琳求职雷达/], ["/updates.html", /更新记录｜梦琳求职雷达/]]) {
    const page = await fetch(`${base}${pathname}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
    assert.equal(page.headers.get("cache-control"), "no-cache");
    assert.match(await page.text(), expectedTitle);
  }
  const clientScript = await fetch(`${base}/app.js`);
  assert.equal(clientScript.headers.get("cache-control"), "no-cache");
  const homepage = await (await fetch(`${base}/`)).text();
  assert.match(homepage, /app\.js\?v=20260824\.2/);
  assert.match(homepage, /sources\.html\?v=20260824\.2/);
  assert.match(homepage, /核验并发布岗位/);
});
