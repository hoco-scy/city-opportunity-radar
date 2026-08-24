import test from "node:test";
import assert from "node:assert/strict";
import { inspectCollectorRuntime } from "../scripts/verify-collector-runtime.mjs";

test("all script-labelled sources have a stateless runnable collector contract", async () => {
  const runtime = await inspectCollectorRuntime();
  assert.equal(runtime.readyForOfflineContractTest, true);
  assert.equal(runtime.usesNoExternalPackages, false);
  assert.equal(runtime.packagesDeclared, true);
  assert.deepEqual(runtime.requiredPackages, ["adm-zip", "xlsx"]);
  assert.ok(runtime.collectors.some((item) => item.sourceId === "buaa-career-discovery"));
  assert.ok(runtime.collectors.some((item) => item.sourceId === "iguopin-discovery"));
  assert.ok(runtime.collectors.some((item) => item.sourceId === "national-college-employment"));
  assert.ok(runtime.collectors.some((item) => item.sourceId === "picc-campus"));
  assert.ok(runtime.collectors.some((item) => item.sourceId === "boe-campus"));
  assert.ok(runtime.collectors.some((item) => item.sourceId === "crc-careers"));
  assert.ok(!runtime.collectors.some((item) => item.sourceId === "chinatelecom-careers"));
  assert.ok(runtime.collectors.every((item) => item.scriptPresent));
  assert.ok(runtime.collectors.every((item) => item.hardGuard));
});
