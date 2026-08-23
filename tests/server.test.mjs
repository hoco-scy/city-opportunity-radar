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

  const { server, db } = createRadarServer({ databasePath });
  t.after(() => { db.close(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const health = await request(base, "/api/health");
  assert.equal(health.response.status, 200);
  assert.deepEqual(health.body, { ok: true, database: "sqlite", cities: 4 });

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

  const shortcuts = await request(base, "/api/cities/beijing/sources?view=shortcut");
  assert.ok(shortcuts.body.sources.length >= 27);
  assert.ok(shortcuts.body.sources.every((item) => item.entryUrl));
  assert.ok(shortcuts.body.sources.every((item) => !Object.hasOwn(item, "latestCheck")));

  const collection = await request(base, "/api/cities/beijing/sources?view=collection");
  assert.ok(collection.body.sources.length > 0);
  assert.ok(collection.body.sources.every((item) => item.collectionEntryUrl));
  assert.ok(collection.body.sources.every((item) => item.collectionMethod));
  assert.ok(collection.body.sources.every((item) => !/待登记/.test(item.collectionMethod)));
  const beijingSelection = collection.body.sources.find((item) => item.id === "beijing-selection-program");
  assert.equal(beijingSelection.organization, "北航就业信息网（公务员／选调生）");
  assert.match(beijingSelection.collectionEntryUrl, /^https:\/\/career\.buaa\.edu\.cn\//);
  assert.equal(collection.body.sources.find((item) => item.id === "buaa-career-discovery")?.collectionMethod, "北航公开筛选脚本（线索待回溯）");
  assert.equal(collection.body.sources.find((item) => item.id === "iguopin-discovery")?.collectionMethod, "平台原生筛选与官方原文回溯");
  for (const cityId of ["shanghai", "guangzhou", "shenzhen"]) {
    const cityCollection = await request(base, `/api/cities/${cityId}/sources?view=collection`);
    const selection = cityCollection.body.sources.find((item) => item.id === `${cityId}-selection-program`);
    assert.equal(selection.organization, "北航就业信息网（公务员／选调生）");
    assert.match(selection.collectionEntryUrl, /^https:\/\/career\.buaa\.edu\.cn\//);
  }
  assert.ok(collection.body.sources.some((item) => item.latestCheck));
  assert.ok(collection.body.sources.some((item) => item.latestCheck?.isCurrent));
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
  assert.match(homepage, /app\.js\?v=20260823\.2/);
  assert.match(homepage, /sources\.html\?v=20260823\.2/);
});
