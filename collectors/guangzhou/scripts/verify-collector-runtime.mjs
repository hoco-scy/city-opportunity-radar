#!/usr/bin/env node
/**
 * Stateless preflight for collectors that a fresh Codex cloud container can run.
 * With --live it performs the no-login, filtered 北航就业信息网、国聘和国家大学生就业服务平台 discovery checks.
 */
import { access, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectNCSSDiscovery } from "./collect-ncss-discovery.mjs";

const root = new URL("../", import.meta.url);
const MINIMUM_NODE_MAJOR = 18;

function nodeMajor() {
  return Number(process.versions.node.split(".")[0]);
}

function commandScript(command) {
  return typeof command === "string" ? command.match(/^node\s+(scripts\/[A-Za-z0-9._-]+\.mjs)(?:\s|$)/)?.[1] : undefined;
}

export async function inspectCollectorRuntime() {
  const [recipesRaw, registryRaw, packageRaw] = await Promise.all([
    readFile(new URL("data/filter-recipes.json", root), "utf8"),
    readFile(new URL("data/source-registry.json", root), "utf8"),
    readFile(new URL("package.json", root), "utf8")
  ]);
  const recipes = JSON.parse(recipesRaw);
  const registry = JSON.parse(registryRaw);
  const monitored = new Set(registry.sources.filter((source) => source.monitoringEnabled !== false).map((source) => source.id));
  const packageManifest = JSON.parse(packageRaw);
  const collectors = [];
  for (const recipe of recipes.recipes.filter((item) => monitored.has(item.sourceId) && item.collection?.primary === "script")) {
    const script = commandScript(recipe.collection.implementation?.command);
    let scriptPresent = false;
    if (script) {
      try { await access(new URL(script, root)); scriptPresent = true; }
      catch { /* reported below */ }
    }
    collectors.push({
      sourceId: recipe.sourceId,
      command: recipe.collection.implementation?.command,
      smokeTest: recipe.collection.implementation?.smokeTest,
      script,
      scriptPresent,
      hardGuard: recipe.collection.implementation?.hardGuard
    });
  }
  const webApis = {
    fetch: typeof fetch === "function",
    url: typeof URL === "function",
    abortSignalTimeout: typeof AbortSignal?.timeout === "function"
  };
  const requiredPackages = ["adm-zip", "xlsx"];
  const packagesDeclared = requiredPackages.every((name) => packageManifest.dependencies?.[name]);
  return {
    node: process.version,
    minimumNodeMajor: MINIMUM_NODE_MAJOR,
    nodeVersionSupported: nodeMajor() >= MINIMUM_NODE_MAJOR,
    usesNoExternalPackages: false,
    requiredPackages,
    packagesDeclared,
    requiresCredentials: false,
    webApis,
    collectors,
    readyForOfflineContractTest: nodeMajor() >= MINIMUM_NODE_MAJOR && Object.values(webApis).every(Boolean) && packagesDeclared && collectors.length > 0 && collectors.every((item) => item.scriptPresent && item.hardGuard)
  };
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: fileURLToPath(root), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `采集冒烟命令退出：${code}`)));
  });
}

export async function runLiveSmoke() {
  const [buaaOut, iguopinOut, ncss] = await Promise.all([
    run(process.execPath, ["scripts/collect-buaa-discovery.mjs", "--city", "广州"]),
    run(process.execPath, ["scripts/collect-iguopin-discovery.mjs", "--city", "广州"]),
    collectNCSSDiscovery({ city: "广州" })
  ]);
  const buaa = JSON.parse(buaaOut);
  const iguopin = JSON.parse(iguopinOut);
  for (const result of [buaa, iguopin, ncss]) {
    if (result.collectionMethod !== "script" || result.nativeFilterQueries < 1 || !Array.isArray(result.pagesVisited) || !result.pagesVisited.length) {
      throw new Error(`${result.sourceId || "公开"}筛选冒烟检查未能证明脚本实际使用原生筛选请求。`);
    }
  }
  return { buaa, iguopin, ncss };
}

async function main() {
  const runtime = await inspectCollectorRuntime();
  const output = { runtime };
  if (!runtime.readyForOfflineContractTest) throw new Error("当前容器不满足无状态采集器运行前提。");
  if (process.argv.includes("--live")) output.liveSmoke = await runLiveSmoke();
  console.log(JSON.stringify(output, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: "runtime-not-ready", error: error.message }, null, 2));
    process.exitCode = 1;
  });
}
