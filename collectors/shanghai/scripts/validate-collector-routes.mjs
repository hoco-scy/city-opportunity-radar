#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const SUPPORTED_COLLECTORS = new Set([
  "public-exam",
  "official-notice-feed",
  "picc-campus",
  "boe-campus",
  "crc-careers",
  "buaa-discovery",
  "iguopin-discovery",
  "ncss-discovery"
]);

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, root), "utf8"));
}

export async function validateCollectorRoutes() {
  const [plan, registry, recipes, manifest] = await Promise.all([
    readJson("data/source-plan.json"),
    readJson("data/source-registry.json"),
    readJson("data/filter-recipes.json"),
    readJson("data/collector-routes.json")
  ]);
  const scheduled = [...new Set([
    ...(plan.coverage?.everyRunOfficial || []),
    ...(plan.coverage?.everyRunDiscovery || [])
  ])];
  const registered = new Set((registry.sources || []).map((source) => source.id));
  const recipeBySource = new Map((recipes.recipes || []).map((recipe) => [recipe.sourceId, recipe]));
  const errors = [];

  for (const sourceId of scheduled) {
    const route = manifest.routes?.[sourceId];
    if (!registered.has(sourceId)) errors.push(`${sourceId}: source-registry 缺失`);
    if (!route) {
      errors.push(`${sourceId}: 没有显式采集器路由`);
      continue;
    }
    if (!SUPPORTED_COLLECTORS.has(route.collector)) errors.push(`${sourceId}: 不支持的采集器 ${route.collector}`);
    const recipe = recipeBySource.get(sourceId);
    if (recipe?.collection?.primary !== "script") {
      errors.push(`${sourceId}: 完整更新来源没有登记 primary=script 的采集配方`);
    }
    if (!recipe?.collection?.implementation?.command) {
      errors.push(`${sourceId}: 完整更新来源缺少可执行的脚本命令`);
    }
  }
  for (const sourceId of Object.keys(manifest.routes || {})) {
    if (!scheduled.includes(sourceId)) errors.push(`${sourceId}: 路由存在但未列入完整更新计划`);
  }
  if (errors.length) throw new Error(`采集器路由门禁失败：\n- ${errors.join("\n- ")}`);
  return { city: recipes.city, scheduled: scheduled.length, routed: Object.keys(manifest.routes || {}).length };
}

const result = await validateCollectorRoutes();
console.log(JSON.stringify({ ok: true, ...result }, null, 2));
