import test from "node:test";
import assert from "node:assert/strict";
import { mergeDiscoveryCandidates, mergeOfficialMonitors } from "../scripts/collection-merge.mjs";

test("发现来源失败时只保留该来源旧候选，成功的来源正常替换", () => {
  const merged = mergeDiscoveryCandidates(
    [{ id: "old-buaa", sourceId: "buaa" }, { id: "old-guopin", sourceId: "guopin" }],
    [{ id: "new-guopin", sourceId: "guopin" }],
    [{ sourceId: "buaa", collectionError: "timeout" }, { sourceId: "guopin", leads: [{}] }]
  );
  assert.deepEqual(merged.map((item) => item.id), ["new-guopin", "old-buaa"]);
});

test("公告来源未完整完成时保留旧监测项，完成后才替换", () => {
  const previous = [{ id: "old-a", sourceId: "a" }, { id: "old-b", sourceId: "b" }];
  const fresh = [{ id: "new-a", sourceId: "a" }];
  const results = new Map([
    ["a", { status: "checked-official-notice-feed" }],
    ["b", { status: "accessible-incomplete" }]
  ]);
  assert.deepEqual(mergeOfficialMonitors(previous, fresh, results).map((item) => item.id), ["new-a", "old-b"]);
});
