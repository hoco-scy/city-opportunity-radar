#!/usr/bin/env node
/**
 * Keep machine-readable source recipes aligned with the collector route
 * manifest. This is a deterministic configuration migration, not a collector.
 */
import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const recipeUrl = new URL("data/filter-recipes.json", root);
const registryUrl = new URL("data/source-registry.json", root);
const [recipes, routeManifest, registry] = await Promise.all([
  readFile(recipeUrl, "utf8").then(JSON.parse),
  readFile(new URL("data/collector-routes.json", root), "utf8").then(JSON.parse),
  readFile(registryUrl, "utf8").then(JSON.parse)
]);

const accessModeByCollector = {
  "public-exam": "script-public-exam",
  "official-notice-feed": "script-official-notice-adapter",
  "picc-campus": "script-official-structured-list",
  "boe-campus": "script-official-structured-list",
  "crc-careers": "script-official-public-gateway",
  "buaa-discovery": "script-buaa-public-filtered-discovery",
  "iguopin-discovery": "script-iguopin-public-filtered-discovery",
  "ncss-discovery": "script-ncss-public-filtered-discovery"
};

for (const source of registry.sources || []) {
  const route = routeManifest.routes?.[source.id];
  if (!route) continue;
  source.collectionAccessMode = accessModeByCollector[route.collector];
  source.collectionNote ||= route.description;
}

const scriptSteps = (sourceId) => [
  `运行 node scripts/collect-official-notice-feed.mjs --source ${sourceId}，从登记入口及官方备用入口读取公告列表。`,
  "按该来源页面结构解析招聘公告链接、脚本跳转和官方附件；所有分页或列表项均在脚本中完成。",
  "公告阶段不按岗位名称或医疗词删减；取得具体岗位后，只用官方专业、学历、届别和其他资格字段判断是否可报。",
  "任一页面结构未解析完整时记录 accessible-incomplete 并保留上次结果，禁止回退为浏览器逐岗扫描。"
];

let changed = 0;
for (const recipe of recipes.recipes || []) {
  if (routeManifest.routes?.[recipe.sourceId]?.collector !== "official-notice-feed") continue;
  const steps = scriptSteps(recipe.sourceId);
  recipe.accessMode = "script-official-notice-adapter";
  recipe.queryPlan = {
    ...(recipe.queryPlan || {}),
    everyRun: steps,
    completionRule: "脚本已读取登记入口、公告列表及可公开访问的详情或附件；若页面结构未解析完整，必须明确记录未完成而不能写成 0 条。"
  };
  recipe.collection = {
    primary: "script",
    mode: "official-announcement-adapter-script",
    steps,
    completion: "脚本已处理本来源当前公开公告列表、可访问详情与附件，并输出采集数和资格筛选后的数量；未完成部分有明确状态。",
    fallback: "公开页面改版或临时不可用时按登记入口重试并保留上次已核验结果；浏览器仅用于人工诊断页面结构，不参与日常全量采集。",
    implementation: {
      command: `node scripts/collect-official-notice-feed.mjs --source ${recipe.sourceId}`,
      smokeTest: `node scripts/collect-official-notice-feed.mjs --source ${recipe.sourceId}`,
      runtime: "Node.js 18+；无需登录、浏览器 Cookie 或本地缓存；只访问来源登记中的公开官方域名。",
      hardGuard: "禁止把入口可访问冒充完整采集；禁止浏览器逐岗扫描；公告没有具体岗位与官方资格字段时不得发布为岗位。"
    }
  };
  changed += 1;
}

await writeFile(recipeUrl, `${JSON.stringify(recipes, null, 2)}\n`);
await writeFile(registryUrl, `${JSON.stringify(registry, null, 2)}\n`);
console.log(`已同步 ${Object.keys(routeManifest.routes || {}).length} 个来源的脚本路由，其中 ${changed} 个使用官方公告适配器。`);
