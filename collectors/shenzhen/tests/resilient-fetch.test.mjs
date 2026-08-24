import test from "node:test";
import assert from "node:assert/strict";
import { createCollectionFetch } from "../scripts/resilient-fetch.mjs";

function response(status, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: "https://jobs.example.cn/list",
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    text: async () => "ok"
  };
}

test("429 会遵守 Retry-After 后重试", async () => {
  const sleeps = [];
  let calls = 0;
  const resilientFetch = createCollectionFetch({
    fetchImpl: async () => ++calls === 1 ? response(429, { "retry-after": "2" }) : response(200),
    minHostIntervalMs: 0,
    backoffMs: [0, 0, 0],
    sleep: async (delay) => { sleeps.push(delay); },
    random: () => 0.5
  });
  assert.equal((await resilientFetch("https://jobs.example.cn/list")).status, 200);
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [2_000]);
  assert.equal(resilientFetch.stats().rateLimited, 1);
});

test("同一域名的请求保持单并发", async () => {
  let active = 0;
  let maximum = 0;
  const resilientFetch = createCollectionFetch({
    fetchImpl: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return response(200);
    },
    minHostIntervalMs: 0,
    maxAttempts: 1
  });
  await Promise.all([1, 2, 3].map(() => resilientFetch("https://jobs.example.cn/list")));
  assert.equal(maximum, 1);
});

test("403 会立即打开域名熔断且不继续撞站", async () => {
  let calls = 0;
  const resilientFetch = createCollectionFetch({
    fetchImpl: async () => { calls += 1; return response(403); },
    minHostIntervalMs: 0,
    backoffMs: [0, 0, 0]
  });
  await assert.rejects(() => resilientFetch("https://jobs.example.cn/list"), { kind: "circuit-open" });
  await assert.rejects(() => resilientFetch("https://jobs.example.cn/other"), { kind: "circuit-open" });
  assert.equal(calls, 1);
  assert.equal(resilientFetch.stats().blocked, 1);
});

test("HTTP 200 的验证码/WAF 页面也会降级熔断", async () => {
  const waf = {
    ...response(200, { "content-type": "text/html" }),
    clone: () => ({ text: async () => "<title>安全验证</title><div>请输入验证码</div>" })
  };
  const resilientFetch = createCollectionFetch({
    fetchImpl: async () => waf,
    minHostIntervalMs: 0,
    backoffMs: [0, 0, 0]
  });
  await assert.rejects(() => resilientFetch("https://jobs.example.cn/list"), { kind: "circuit-open" });
  assert.equal(resilientFetch.stats().blocked, 1);
});

test("连续请求会执行同域名最小间隔", async () => {
  const sleeps = [];
  const resilientFetch = createCollectionFetch({
    fetchImpl: async () => response(200),
    minHostIntervalMs: 800,
    maxAttempts: 1,
    sleep: async (delay) => { sleeps.push(delay); }
  });
  await resilientFetch("https://jobs.example.cn/one");
  await resilientFetch("https://jobs.example.cn/two");
  assert.ok(sleeps.some((delay) => delay >= 700));
  assert.equal(resilientFetch.stats().throttledWaits, 1);
});

test("断链错误最多重试三次并形成事实计数", async () => {
  let calls = 0;
  const resilientFetch = createCollectionFetch({
    fetchImpl: async () => { calls += 1; throw new TypeError("socket disconnected"); },
    minHostIntervalMs: 0,
    backoffMs: [0, 0, 0],
    transientFailureThreshold: 5
  });
  await assert.rejects(() => resilientFetch("https://jobs.example.cn/list"), { kind: "network", attempts: 3 });
  assert.equal(calls, 3);
  assert.equal(resilientFetch.stats().retries, 2);
});
