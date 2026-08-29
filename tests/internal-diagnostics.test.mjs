import assert from "node:assert/strict";
import test from "node:test";
import {
  collectorPerformanceDiagnostics,
  processDiagnostics,
  sanitizeDiagnosticValue,
  sourceDiagnostics,
} from "../scripts/internal-diagnostics.mjs";

test("内部日志保留排障参数但遮蔽凭据", () => {
  const sanitized = sanitizeDiagnosticValue({
    url: "https://jobs.example.cn/list?page=2&city=beijing&token=private-value",
    authorization: "Bearer private-value",
    note: "cookie=session-value request failed",
  });
  assert.match(sanitized.url, /page=2/);
  assert.match(sanitized.url, /city=beijing/);
  assert.doesNotMatch(JSON.stringify(sanitized), /private-value|session-value/);
  assert.equal(sanitized.authorization, "[redacted]");
});

test("来源诊断补充缓存比例、请求均值和访问证据", () => {
  const diagnostic = sourceDiagnostics({
    status: "checked",
    collectionMetrics: { collected: 30, afterFilter: 4 },
    performance: { durationMs: 2_000, logicalRequests: 10, actualAttempts: 6, sharedCacheHits: 4, requestDurationMs: 1_500 },
    accessEvidence: [{ requestedUrl: "https://jobs.example.cn/list?page=1", outcome: "success" }],
  });
  assert.equal(diagnostic.performance.averageLogicalRequestMs, 150);
  assert.equal(diagnostic.performance.cacheHitRate, 0.4);
  assert.equal(diagnostic.performance.attemptReuseRate, 0.4);
  assert.equal(diagnostic.accessEvidence[0].outcome, "success");
});

test("子进程和采集器诊断包含耗时、输出摘要与完整来源排序", () => {
  const process = processDiagnostics({ code: 0, durationMs: 123, stdoutBytes: 9, stderrBytes: 0, stdout: "done", stderr: "" });
  assert.deepEqual(process, { exitCode: 0, durationMs: 123, stdoutBytes: 9, stderrBytes: 0, stdoutTail: "done", stderrTail: null });
  const performance = collectorPerformanceDiagnostics([
    { sourceId: "fast", durationMs: 10, logicalRequests: 1, actualAttempts: 1, sharedCacheHits: 0, persistentCacheHits: 0, requestDurationMs: 8 },
    { sourceId: "slow", durationMs: 100, logicalRequests: 5, actualAttempts: 3, sharedCacheHits: 2, persistentCacheHits: 1, requestDurationMs: 80 },
  ]);
  assert.equal(performance.collectors[0].sourceId, "slow");
  assert.deepEqual(performance.totals, { logicalRequests: 6, actualAttempts: 4, sharedCacheHits: 2, persistentCacheHits: 1, cumulativeRequestDurationMs: 88 });
});
