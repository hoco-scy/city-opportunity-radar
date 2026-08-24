#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const dataUrl = new URL("../data/opportunities.json", import.meta.url);
const [data, registry] = await Promise.all([
  readFile(dataUrl, "utf8").then(JSON.parse),
  readFile(new URL("../data/source-registry.json", import.meta.url), "utf8").then(JSON.parse)
]);
const sources = new Map(registry.sources.map((source) => [source.id, source]));
const nonActionable = /(拟聘|公示|取消|录用结果|面试(?:公告|名单|安排)|资格审查结果|笔试成绩)/;
const enterpriseExperiencedOnly = /(社会(?:公开)?招聘|成熟人才|博士后)/;
const earlyCareer = /(校园|校招|应届|毕业生|管培|优才|公开招聘|招聘工作人员|选调|优培|招录)/;
const genericNavigation = /^(?:\/\s*)?(事业单位公开招聘|毕业生就业|招聘动态\s*>?)$/;
const deduplicated = new Map();
for (const monitor of data.monitors || []) {
  const source = sources.get(monitor.sourceId);
  const title = String(monitor.title || "").trim();
  if (source && String(monitor.id || "").startsWith("notice-")) {
    if (!title || genericNavigation.test(title) || nonActionable.test(title) || !earlyCareer.test(title)) continue;
    if (source.coverage?.includes("国有企业") && enterpriseExperiencedOnly.test(title) && !/(校园|校招|应届|毕业生)/.test(title)) continue;
  }
  const next = monitor.sourceId && String(monitor.id || "").startsWith("notice-")
    ? {
        ...monitor,
        id: `notice-${monitor.sourceId}-${createHash("sha256").update(String(monitor.officialUrl)).digest("hex").slice(0, 18)}`
      }
    : monitor;
  deduplicated.set(next.id, next);
}
data.monitors = [...deduplicated.values()];
await writeFile(dataUrl, `${JSON.stringify(data, null, 2)}\n`);
console.log(`公告监测项已重建稳定 ID：${data.monitors.length} 条。`);
