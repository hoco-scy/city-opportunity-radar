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

test("聚合来源之间去重，并排除已经由官方采集器核验的同一岗位", () => {
  const fresh = [
    { id: "aiball-1", sourceId: "aiball", organization: "某央企", title: "科研岗", priority: 78 },
    { id: "other-1", sourceId: "other", organization: "某央企", exactTitle: "科研岗", priority: 68 },
    { id: "keep", sourceId: "other", organization: "某事业单位", title: "项目岗", priority: 64 }
  ];
  const verified = [{ organization: "某央企", exactTitle: "科研岗" }];
  assert.deepEqual(mergeDiscoveryCandidates([], fresh, [], verified).map((item) => item.id), ["keep"]);
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
