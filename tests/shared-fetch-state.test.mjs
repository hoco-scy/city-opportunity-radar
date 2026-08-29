import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCollectionFetch } from "../collectors/beijing/scripts/resilient-fetch.mjs";

async function temporaryState(t) {
  const directory = await mkdtemp(join(tmpdir(), "radar-shared-fetch-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("四城共享缓存会合并同时发生的相同公开请求", async (t) => {
  const sharedStateDir = await temporaryState(t);
  let calls = 0;
  const upstream = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return jsonResponse({ ok: true });
  };
  const first = createCollectionFetch({ fetchImpl: upstream, sharedStateDir, minHostIntervalMs: 0, maxAttempts: 1 });
  const second = createCollectionFetch({ fetchImpl: upstream, sharedStateDir, minHostIntervalMs: 0, maxAttempts: 1 });

  const [left, right] = await Promise.all([
    first("https://jobs.example.cn/list?page=1"),
    second("https://jobs.example.cn/list?page=1"),
  ]);

  assert.deepEqual(await left.json(), { ok: true });
  assert.deepEqual(await right.json(), { ok: true });
  assert.equal(calls, 1);
  assert.equal(first.stats().attempts + second.stats().attempts, 1);
  assert.equal(first.stats().sharedCacheHits + second.stats().sharedCacheHits, 1);
});

test("四城不同请求仍共用同一域名的单并发队列", async (t) => {
  const sharedStateDir = await temporaryState(t);
  let active = 0;
  let maximum = 0;
  const upstream = async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return jsonResponse({ ok: true });
  };
  const first = createCollectionFetch({ fetchImpl: upstream, sharedStateDir, minHostIntervalMs: 0, maxAttempts: 1 });
  const second = createCollectionFetch({ fetchImpl: upstream, sharedStateDir, minHostIntervalMs: 0, maxAttempts: 1 });

  await Promise.all([
    first("https://jobs.example.cn/list?page=1"),
    second("https://jobs.example.cn/list?page=2"),
  ]);

  assert.equal(maximum, 1);
});

test("动态签名网址可以用显式键复用只读响应", async (t) => {
  const sharedStateDir = await temporaryState(t);
  let calls = 0;
  const upstream = async () => { calls += 1; return jsonResponse({ rows: [1, 2, 3] }); };
  const first = createCollectionFetch({ fetchImpl: upstream, sharedStateDir, minHostIntervalMs: 0, maxAttempts: 1 });
  const second = createCollectionFetch({ fetchImpl: upstream, sharedStateDir, minHostIntervalMs: 0, maxAttempts: 1 });
  const init = { method: "POST", body: "{}", radarCacheKey: "crc:page:1" };

  await first("https://jobs.example.cn/gateway?signature=first", init);
  await second("https://jobs.example.cn/gateway?signature=second", init);

  assert.equal(calls, 1);
  assert.equal(second.stats().sharedCacheHits, 1);
});

test("岗位列表不会跨轮复用，指纹化详情可以在下一轮复用", async (t) => {
  const persistentCacheDir = await temporaryState(t);
  const firstRunDir = await temporaryState(t);
  const secondRunDir = await temporaryState(t);
  let calls = 0;
  const upstream = async () => { calls += 1; return jsonResponse({ version: calls }); };
  const first = createCollectionFetch({ fetchImpl: upstream, sharedStateDir: firstRunDir, persistentCacheDir, minHostIntervalMs: 0, maxAttempts: 1 });
  const second = createCollectionFetch({ fetchImpl: upstream, sharedStateDir: secondRunDir, persistentCacheDir, minHostIntervalMs: 0, maxAttempts: 1 });

  await first("https://jobs.example.cn/list?page=1");
  await second("https://jobs.example.cn/list?page=1");
  assert.equal(calls, 2);

  const detailInit = { radarCacheScope: "persistent", radarCacheKey: "notice:unchanged-fingerprint", radarCacheTtlMs: 60_000 };
  await first("https://jobs.example.cn/detail/1", detailInit);
  const cached = await second("https://jobs.example.cn/detail/1", detailInit);
  assert.equal(calls, 3);
  assert.equal(cached.radarPersistentCacheHit, true);
  assert.equal(second.stats().persistentCacheHits, 1);
});

test("持久详情缓存过期后重新核验", async (t) => {
  const persistentCacheDir = await temporaryState(t);
  const firstRunDir = await temporaryState(t);
  const secondRunDir = await temporaryState(t);
  let calls = 0;
  const upstream = async () => { calls += 1; return jsonResponse({ version: calls }); };
  const init = { radarCacheScope: "persistent", radarCacheKey: "notice:short-lived", radarCacheTtlMs: 1 };
  await createCollectionFetch({ fetchImpl: upstream, sharedStateDir: firstRunDir, persistentCacheDir, minHostIntervalMs: 0, maxAttempts: 1 })("https://jobs.example.cn/detail/1", init);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await createCollectionFetch({ fetchImpl: upstream, sharedStateDir: secondRunDir, persistentCacheDir, minHostIntervalMs: 0, maxAttempts: 1 })("https://jobs.example.cn/detail/1", init);
  assert.equal(calls, 2);
});

test("相同详情指纹会滚动续约，但首次写入满硬上限仍会回源", async (t) => {
  const persistentCacheDir = await temporaryState(t);
  const firstRunDir = await temporaryState(t);
  const secondRunDir = await temporaryState(t);
  const thirdRunDir = await temporaryState(t);
  let calls = 0;
  const upstream = async () => { calls += 1; return jsonResponse({ version: calls }); };
  const init = {
    radarCacheScope: "persistent",
    radarCacheKey: "notice:rolling-fingerprint",
    radarCacheTtlMs: 1_000,
    radarCacheMaxAgeMs: 10_000,
  };

  await createCollectionFetch({ fetchImpl: upstream, sharedStateDir: firstRunDir, persistentCacheDir, minHostIntervalMs: 0, maxAttempts: 1 })("https://jobs.example.cn/detail/rolling", init);
  const responseDirectory = join(persistentCacheDir, "responses");
  const metadataFilename = (await readdir(responseDirectory)).find((filename) => filename.endsWith(".json"));
  const metadataPath = join(responseDirectory, metadataFilename);
  const beforeRenewal = JSON.parse(await readFile(metadataPath, "utf8"));
  beforeRenewal.storedAt = new Date(Date.now() - 2_000).toISOString();
  beforeRenewal.lastConfirmedAt = new Date(Date.now() - 500).toISOString();
  await writeFile(metadataPath, JSON.stringify(beforeRenewal));

  const renewed = await createCollectionFetch({ fetchImpl: upstream, sharedStateDir: secondRunDir, persistentCacheDir, minHostIntervalMs: 0, maxAttempts: 1 })("https://jobs.example.cn/detail/rolling", init);
  const afterRenewal = JSON.parse(await readFile(metadataPath, "utf8"));
  assert.equal(renewed.radarPersistentCacheHit, true);
  assert.equal(calls, 1);
  assert.ok(Date.parse(afterRenewal.lastConfirmedAt) > Date.parse(beforeRenewal.lastConfirmedAt));

  afterRenewal.storedAt = new Date(Date.now() - 20_000).toISOString();
  afterRenewal.lastConfirmedAt = new Date().toISOString();
  await writeFile(metadataPath, JSON.stringify(afterRenewal));
  await createCollectionFetch({ fetchImpl: upstream, sharedStateDir: thirdRunDir, persistentCacheDir, minHostIntervalMs: 0, maxAttempts: 1 })("https://jobs.example.cn/detail/rolling", init);
  assert.equal(calls, 2);
});
