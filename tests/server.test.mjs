import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createRadarServer } from "../server.mjs";
import { importCityCollectors } from "../scripts/import-city-collectors.mjs";
import {
  acquireUpdateLock,
  finishUpdateRun,
  getUpdateRun,
  isValidUserCode,
  isProfileRelevantOpportunity,
  isPubliclyDisplayableOpportunity,
  listUpdateEvents,
  normalizePublicLocation,
  openRadarDatabase,
  saveUpdateSchedule,
} from "../db.mjs";
import { createScheduleController, nextDailyRun } from "../scheduler.mjs";
import {
  isOpportunityWithinRetention,
  opportunityRetentionInfo,
  publicRetentionCutoff,
} from "../retention.mjs";

const projectRoot = resolve(new URL("../", import.meta.url).pathname);
const collectorsRoot = resolve(projectRoot, "collectors");
const validCode = "menglin_user_2026";

async function request(base, path, options) {
  const response = await fetch(`${base}${path}`, options);
  return { response, body: await response.json() };
}

test("publishes eligible biomedical roles without mistaking computing disciplines for broad engineering", () => {
  assert.equal(isPubliclyDisplayableOpportunity({
    track: "央国企", title: "人工智能工程师（安全方向）", majors: "生物医学工程、医学工程相关专业", responsibilities: ["开展通用算法研发"],
    officialApplyUrl: "https://example.gov.cn/apply", verification: { officialSource: true, specificPosition: true, eligibility: true, applicationPath: true },
  }), false);
  assert.equal(isPubliclyDisplayableOpportunity({
    track: "央国企", title: "医学影像软件工程师", majors: "生物医学工程、医学工程相关专业", responsibilities: ["开发医学影像设备软件"],
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
  assert.equal(isProfileRelevantOpportunity({
    track: "待确认线索", title: "软件开发工程师", majors: "计算机类；软件工程类；网络空间安全类",
  }), false);
  assert.equal(isProfileRelevantOpportunity({
    track: "待确认线索", title: "设备工程师", majors: "工学门类；理工类",
  }), true);
  assert.equal(normalizePublicLocation("北京市大兴区；北京市；北京市大兴区；北京市"), "北京市大兴区");
});

test("accepts manually chosen user identifiers and keeps legacy favorite codes compatible", () => {
  assert.equal(isValidUserCode("menglin_user_2026"), true);
  assert.equal(isValidUserCode("user-01"), true);
  assert.equal(isValidUserCode(`mlr_${"a".repeat(64)}`), true);
  assert.equal(isValidUserCode("short"), false);
  assert.equal(isValidUserCode("含中文的标识符"), false);
  assert.equal(isValidUserCode("space is invalid"), false);
});

test("keeps only information published within the latest six calendar months", () => {
  const now = new Date("2026-08-24T12:00:00+08:00");
  assert.equal(publicRetentionCutoff(now), "2026-02-24");
  assert.equal(isOpportunityWithinRetention({ publishedAt: "2026-02-24" }, { now }), true);
  assert.equal(isOpportunityWithinRetention({ publishedAt: "2026-02-23", verifiedAt: "2026-08-24" }, { now }), false);
  assert.equal(isOpportunityWithinRetention({ checkedAt: "2026-08-23" }, { now }), true);
  assert.equal(isOpportunityWithinRetention({ title: "没有任何可核验日期" }, { now }), false);
  assert.deepEqual(opportunityRetentionInfo({ publishedAt: "2025-11-13", verifiedAt: "2026-08-24" }, { now }), {
    keep: false,
    date: "2025-11-13",
    cutoff: "2026-02-24",
    basis: "publishedAt",
    hasPublicationDate: true,
  });
  assert.equal(publicRetentionCutoff(new Date("2026-08-31T12:00:00+08:00")), "2026-02-28");
});

test("computes the next daily run in Beijing time", () => {
  const schedule = { enabled: true, timezone: "Asia/Shanghai", times: ["09:00", "14:00"] };
  assert.equal(nextDailyRun(schedule, new Date("2026-08-24T00:30:00.000Z")).toISOString(), "2026-08-24T01:00:00.000Z");
  assert.equal(nextDailyRun(schedule, new Date("2026-08-24T06:30:00.000Z")).toISOString(), "2026-08-25T01:00:00.000Z");
  assert.equal(nextDailyRun({ ...schedule, enabled: false }, new Date("2026-08-24T00:30:00.000Z")), null);
});

test("定时触发撞锁后合并为一次补跑，而不是丢弃或并行", async (t) => {
  const workdir = await mkdtemp(join(tmpdir(), "menglin-radar-catchup-"));
  const databasePath = join(workdir, "radar.sqlite");
  const db = openRadarDatabase(databasePath);
  t.after(async () => rm(workdir, { recursive: true, force: true }));
  t.after(() => db.close());
  saveUpdateSchedule(db, { enabled: true, times: ["09:00"], updatedBy: "test" });

  const realStartedAt = Date.now();
  const virtualStartedAt = new Date("2026-08-24T00:59:59.990Z").getTime();
  const triggers = [];
  const controller = createScheduleController({
    db,
    now: () => new Date(virtualStartedAt + Date.now() - realStartedAt),
    collisionRetryMs: 5,
    syncController: {
      start(trigger) {
        triggers.push(trigger);
        return { alreadyRunning: triggers.length === 1 };
      }
    }
  });
  t.after(() => controller.stop());
  controller.refresh();
  for (let attempt = 0; attempt < 30 && triggers.length < 2; attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  assert.deepEqual(triggers, ["schedule", "schedule-catchup"]);
  assert.equal(controller.current().catchupQueued, false);
});

test("uses one persistent update lock across database connections", async (t) => {
  const workdir = await mkdtemp(join(tmpdir(), "menglin-radar-lock-"));
  const databasePath = join(workdir, "radar.sqlite");
  const firstDb = openRadarDatabase(databasePath);
  const secondDb = openRadarDatabase(databasePath);
  t.after(async () => rm(workdir, { recursive: true, force: true }));
  t.after(() => { firstDb.close(); secondDb.close(); });

  const first = acquireUpdateLock(firstDb, { runId: "run-first", trigger: "manual", requestedBy: "tester" });
  assert.equal(first.acquired, true);
  const duplicate = acquireUpdateLock(secondDb, { runId: "run-duplicate", trigger: "schedule" });
  assert.equal(duplicate.acquired, false);
  assert.equal(duplicate.run.runId, "run-first");
  assert.equal(getUpdateRun(secondDb, "run-duplicate"), null);

  finishUpdateRun(firstDb, "run-first", { state: "completed", summary: { importedCityCount: 4, failedCityCount: 0 } });
  assert.equal(listUpdateEvents(secondDb, "run-first").at(-1).phase, "run-finished");
  const next = acquireUpdateLock(secondDb, { runId: "run-next", trigger: "schedule" });
  assert.equal(next.acquired, true);
  finishUpdateRun(secondDb, "run-next", { state: "completed", summary: { importedCityCount: 4, failedCityCount: 0 } });
});

test("imports all four cities and exposes the unified public API", async (t) => {
  const workdir = await mkdtemp(join(tmpdir(), "menglin-radar-"));
  const databasePath = join(workdir, "radar.sqlite");
  t.after(async () => rm(workdir, { recursive: true, force: true }));

  const summary = await importCityCollectors({ collectorsRoot, databasePath });
  assert.equal(summary.length, 4);
  assert.deepEqual(summary.map((item) => item.cityId), ["beijing", "shanghai", "guangzhou", "shenzhen"]);
  assert.ok(summary.every((item) => item.sources >= 27));

  let syncCalls = 0;
  let releaseSync;
  const syncBarrier = new Promise((resolveBarrier) => { releaseSync = resolveBarrier; });
  t.after(() => releaseSync());
  const { server, db } = createRadarServer({
    databasePath,
    bootstrapAdmin: { username: "menglin-admin", password: "test-only-admin-password" },
    syncRunner: async ({ onProgress }) => {
      syncCalls += 1;
      onProgress({ phase: "city-start", cityId: "beijing", message: "北京开始执行完整采集工作流。" });
      onProgress({
        phase: "source-check",
        cityId: "beijing",
        sourceId: "test-source",
        message: "测试来源：采集 12 条，筛选后 3 条。",
        data: { collectionMetrics: { collected: 12, afterFilter: 3 } },
      });
      await syncBarrier;
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
  assert.equal(syncStart.body.state, "running");
  assert.equal(syncStart.body.alreadyRunning, false);
  const duplicateSync = await request(base, "/api/admin/sync", { method: "POST", headers: adminHeaders, body: "{}" });
  assert.equal(duplicateSync.response.status, 202);
  assert.equal(duplicateSync.body.alreadyRunning, true);
  assert.equal(duplicateSync.body.runId, syncStart.body.runId);
  const runningStatus = await request(base, `/api/admin/sync?runId=${syncStart.body.runId}&after=0`, { headers: adminHeaders });
  assert.equal(runningStatus.body.state, "running");
  assert.ok(runningStatus.body.events.some((event) => event.phase === "run-start"));
  assert.ok(runningStatus.body.events.some((event) => event.phase === "source-check" && event.data.collectionMetrics.collected === 12));
  assert.equal(syncCalls, 1);
  const lastSequence = runningStatus.body.nextSequence;
  releaseSync();
  let syncStatus;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    syncStatus = await request(base, `/api/admin/sync?runId=${syncStart.body.runId}&after=${lastSequence}`, { headers: adminHeaders });
    if (syncStatus.body.state !== "running") break;
  }
  assert.equal(syncStatus.body.state, "completed");
  assert.ok(syncStatus.body.events.some((event) => event.phase === "run-finished"));

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
  assert.equal(collection.body.sources.find((item) => item.id === "jqzp-beijing-soe")?.collectionMethod, "京企直聘北京应届国企岗位筛选脚本");
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
    assert.match(pageHtml, /id="sync-event-list"/);
  }
  const clientScript = await fetch(`${base}/app.js`);
  assert.equal(clientScript.headers.get("cache-control"), "no-cache");
  const homepage = await (await fetch(`${base}/`)).text();
  assert.match(homepage, /app\.js\?v=20260825\.1/);
  assert.match(homepage, /sources\.html\?v=20260825\.1/);
  assert.match(homepage, /更新控制台/);
  assert.match(homepage, /本站不会自动生成标识符/);
  assert.doesNotMatch(homepage, /待确认线索|核验并发布岗位/);
  const clientSource = await clientScript.text();
  assert.doesNotMatch(clientSource, /crypto\.getRandomValues|function makeCode/);
  assert.match(clientSource, /请先手动输入用户标识符/);
});
