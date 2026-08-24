import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");

if (!app.includes('api("/api/cities")')) throw new Error("页面没有从统一城市接口读取数据");
if (!server.includes("recordType: [\"monitor\", \"candidate\", \"job\"].includes(kind) ? kind : \"all\"")) throw new Error("岗位接口没有默认合并证据层级");
if (!html.includes("生物医学相关背景的硕士")) throw new Error("入口未说明共同筛选范围");
if (!html.includes("梦琳求职雷达")) throw new Error("总站名称未更新");
if (!html.includes('src="assets/yier-bubu-authorized.jpeg"')) throw new Error("缺少已获许可的一二和布布形象");
if (!html.includes('id="update-schedule-times"') || !server.includes('"/api/admin/schedule"')) throw new Error("管理员更新计划链路不完整");
if (/review-dialog|candidate-reviews/.test(html)) throw new Error("页面仍包含管理员岗位审核入口");
console.log("统一站点校验通过：四城岗位、证据状态与管理员更新计划均使用服务端链路。");
