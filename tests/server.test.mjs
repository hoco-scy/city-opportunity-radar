import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createRadarServer } from "../server.mjs";
import { importLegacyCities } from "../scripts/import-legacy-cities.mjs";
import { isPubliclyDisplayableOpportunity } from "../db.mjs";
import { nextDailyRun } from "../scheduler.mjs";

const projectRoot = resolve(new URL("../", import.meta.url).pathname);
const legacyRoot = resolve(projectRoot, "..");
const validCode = `mlr_${"a".repeat(64)}`;

async function request(base, path, options) {
  const response = await fetch(`${base}${path}`, options);
  return { response, body: await response.json() };
}

test("publishes verified roles by official major eligibility, independently of job-title wording", () => {
  assert.equal(isPubliclyDisplayableOpportunity({
    track: "央国企", title: "人工智能工程师", majors: "生物医学工程、医学工程相关专业", responsibilities: ["开展通用算法研发"],
    officialApplyUrl: "https://example.gov.cn/apply", verification: { officialSource: true, specificPosition: true, eligibility: true, applicationPath: true },
  }), true);
  assert.equal(isPubliclyDisplayableOpportunity({
    track: "事业单位", title: "医学影像设备工程师", majors: "生物医学工程、医学工程相关专业", responsibilities: ["负责医学影像设备临床应用支持"],
    officialApplyUrl: "https://example.gov.cn/apply", verification: { officialSource: true, specificPosition: true, eligibility: true, applicationPath: true },
  }), true);
  assert.equal(isPubliclyDisplayableOpportunity({
    track: "央国企", title: "软件工程师", majors: "计算机科学与技术、软件工程", officialApplyUrl: "https://example.gov.cn/apply",
    verification: { officialSource: true, specificPosition: true, applicationPath: true },
  }), false);
  assert.equal(isPubliclyDisplayableOpportunity({
    track: "事业单位", title: "超声医师", majors: "临床医学、超声医学或中医学", officialApplyUrl: "https://example.gov.cn/apply",
    verification: { officialSource: true, specificPosition: true, applicationPath: true },
  }), false);
  assert.equal(isPubliclyDisplayableOpportunity({ track: "考公", title: "已通过资格门禁的岗位" }), true);
});

test("computes the next daily run in Beijing time", () => {
  const schedule = { enabled: true, timezone: "Asia/Shanghai", times: ["09:00", "14:00"] };
  assert.equal(nextDailyRun(schedule, new Date("2026-08-24T00:30:00.000Z")).toISOString(), "2026-08-24T01:00:00.000Z");
  assert.equal(nextDailyRun(schedule, new Date("2026-08-24T06:30:00.000Z")).toISOString(), "2026-08-25T01:00:00.000Z");
  assert.equal(nextDailyRun({ ...schedule, enabled: false }, new Date("2026-08-24T00:30:00.000Z")), null);
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
    schedulerEnabled: false,
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

  const jobs = await request(base, "/api/cities/beijing/opportunities?kind=job&track=%E5%A4%AE%E5%9B%BD%E4%BC%81");
  assert.equal(jobs.response.status, 200);
  assert.ok(jobs.body.opportunities.every((item) => item.track === "央国企"));
  assert.ok(jobs.body.opportunities.every(isPubliclyDisplayableOpportunity));

  const announcements = await request(base, "/api/cities/beijing/opportunities?kind=monitor");
  assert.equal(announcements.response.status, 200);
  assert.ok(announcements.body.opportunities.length >= 5);
  assert.ok(announcements.body.opportunities.every((item) => item.note));

  const candidates = await request(base, "/api/cities/beijing/opportunities?kind=candidate");
  assert.equal(candidates.response.status, 200);
  assert.ok(candidates.body.opportunities.every((item) => item.status === "待用户确认"));
  assert.ok(candidates.body.opportunities.every((item) => item.manualConfirmationRequired === true));
  assert.ok(candidates.body.opportunities.every((item) => item.evidenceStatus === "trusted-source"));

  const unified = await request(base, "/api/cities/beijing/opportunities");
  assert.equal(unified.response.status, 200);
  assert.ok(unified.body.opportunities.some((item) => item.evidenceStatus === "official-verified"));
  assert.ok(unified.body.opportunities.some((item) => item.evidenceStatus === "trusted-source"));
  assert.equal(cities.body.cities[0].opportunity_count, unified.body.opportunities.length);

  const adminLogin = await request(base, "/api/admin/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "menglin-admin", password: "test-only-admin-password" }),
  });
  assert.equal(adminLogin.response.status, 201);
  assert.match(adminLogin.body.token, /^mas_/);
  const adminHeaders = { "x-radar-admin-session": adminLogin.body.token, "content-type": "application/json" };

  const defaultSchedule = await request(base, "/api/admin/schedule", { headers: adminHeaders });
  assert.equal(defaultSchedule.response.status, 200);
  assert.equal(defaultSchedule.body.enabled, false);
  assert.deepEqual(defaultSchedule.body.times, ["09:00", "14:00"]);

  const savedSchedule = await request(base, "/api/admin/schedule", {
    method: "PUT",
    headers: adminHeaders,
    body: JSON.stringify({ enabled: true, times: ["14:00", "09:00", "09:00"] }),
  });
  assert.equal(savedSchedule.response.status, 200);
  assert.equal(savedSchedule.body.enabled, true);
  assert.deepEqual(savedSchedule.body.times, ["09:00", "14:00"]);
  assert.match(savedSchedule.body.nextRunAt, /^\d{4}-\d{2}-\d{2}T/);

  const invalidSchedule = await request(base, "/api/admin/schedule", {
    method: "PUT",
    headers: adminHeaders,
    body: JSON.stringify({ enabled: true, times: ["25:00"] }),
  });
  assert.equal(invalidSchedule.response.status, 400);

  const removedReviewApi = await request(base, "/api/admin/candidate-reviews", {
    method: "POST",
    headers: adminHeaders,
    body: "{}",
  });
  assert.equal(removedReviewApi.response.status, 404);

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
  assert.equal(collection.body.sources.find((item) => item.id === "buaa-career-discovery")?.collectionMethod, "北航就业信息网公开筛选脚本");
  assert.equal(collection.body.sources.find((item) => item.id === "iguopin-discovery")?.collectionMethod, "国聘公开筛选脚本");
  assert.equal(collection.body.sources.find((item) => item.id === "national-college-employment")?.collectionMethod, "国家大学生就业服务平台公开筛选脚本");
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

  const job = candidates.body.opportunities[0];
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
    const pageHtml = await page.text();
    assert.match(pageHtml, expectedTitle);
    assert.match(pageHtml, /class="topbar-actions"/);
    assert.match(pageHtml, /data-admin-trigger/);
    assert.match(pageHtml, /id="admin-dialog"/);
  }
  const clientScript = await fetch(`${base}/app.js`);
  assert.equal(clientScript.headers.get("cache-control"), "no-cache");
  const homepage = await (await fetch(`${base}/`)).text();
  assert.match(homepage, /app\.js\?v=20260824\.4/);
  assert.match(homepage, /sources\.html\?v=20260824\.4/);
  assert.match(homepage, /更新控制台/);
  assert.doesNotMatch(homepage, /待确认线索|核验并发布岗位/);
});
