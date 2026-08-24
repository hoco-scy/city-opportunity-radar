import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const subpages = await Promise.all(["announcements.html", "sources.html", "updates.html"]
  .map((filename) => readFile(new URL(`../${filename}`, import.meta.url), "utf8")));
const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
const compose = await readFile(new URL("../docker-compose.yml", import.meta.url), "utf8");
const transfer = await readFile(new URL("./database-transfer.mjs", import.meta.url), "utf8");

if (!app.includes('api("/api/cities")')) throw new Error("页面没有从统一城市接口读取数据");
if (!server.includes("recordType: [\"monitor\", \"candidate\", \"job\"].includes(kind) ? kind : \"all\"")) throw new Error("岗位接口没有默认合并证据层级");
if (!html.includes("生物医学相关背景的硕士")) throw new Error("入口未说明共同筛选范围");
if (!html.includes("梦琳求职雷达")) throw new Error("总站名称未更新");
if (!html.includes('src="assets/yier-bubu-authorized.jpeg"')) throw new Error("缺少已获许可的一二和布布形象");
if (!html.includes('id="update-schedule-times"') || !server.includes('"/api/admin/schedule"')) throw new Error("管理员更新计划链路不完整");
if (!html.includes('id="sync-event-list"') || !app.includes("renderSyncStatus") || !server.includes("appendUpdateEvent")) throw new Error("管理员事实日志链路不完整");
if (!server.includes("acquireUpdateLock") || !server.includes("alreadyRunning: true")) throw new Error("统一更新没有并发锁");
if (app.includes("crypto.getRandomValues") || app.includes("function makeCode")) throw new Error("页面仍会自动生成收藏代码");
if (!html.includes("本站不会自动生成标识符") || !app.includes("请先手动输入用户标识符")) throw new Error("用户标识符没有改为手动输入");
if (!dockerfile.includes("RADAR_LEGACY_ROOT=/radars") || !compose.includes("radar-data:/data")) throw new Error("Docker 部署没有包含四城采集运行时或持久化数据库");
if (!compose.includes("./backups:/backups") || !transfer.includes("exportDatabaseBackup") || !transfer.includes("restoreDatabaseBackup")) throw new Error("数据库备份与迁移链路不完整");
if (/review-dialog|candidate-reviews/.test(html)) throw new Error("页面仍包含管理员岗位审核入口");
if (subpages.some((content) => !content.includes('class="topbar-actions"') || !content.includes('data-admin-trigger') || !content.includes('id="admin-dialog"') || !content.includes('id="sync-event-list"'))) {
  throw new Error("子页面顶栏或管理员事实日志入口不完整");
}
console.log("统一站点校验通过：四城岗位、证据状态、事实日志与带锁更新计划均使用服务端链路。");
