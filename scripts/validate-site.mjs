import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const destinations = ["beijing", "shanghai", "guangzhou", "shenzhen"];

for (const city of destinations) {
  if (!html.includes(`https://hoco-scy.github.io/${city}-opportunity-radar/`)) throw new Error(`缺少 ${city} 城市站入口`);
  if (!app.includes(`${city}:`)) throw new Error(`缺少 ${city} 下拉跳转`);
}
if (!html.includes("生物医学工程及相近工科背景的硕士")) throw new Error("入口未说明共同筛选范围");
if (!html.includes("梦琳求职雷达")) throw new Error("总站名称未更新");
if (!html.includes('src="assets/yier-bubu-authorized.jpeg"')) throw new Error("缺少已获许可的一二和布布形象");
console.log("城市入口校验通过：四个城市均可从卡片和下拉菜单进入。");
