import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import {
  addFavorite,
  defaultDatabasePath,
  getCityAudit,
  isValidUserCode,
  listCities,
  listFavoriteIds,
  listOpportunities,
  listSources,
  openRadarDatabase,
  removeFavorite,
} from "./db.mjs";

const root = resolve(new URL(".", import.meta.url).pathname);
const staticFiles = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/announcements.html", "announcements.html"],
  ["/sources.html", "sources.html"],
  ["/updates.html", "updates.html"],
  ["/app.js", "app.js"],
  ["/styles.css", "styles.css"],
  ["/assets/yier-bubu-authorized.jpeg", "assets/yier-bubu-authorized.jpeg"],
]);
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".jpeg": "image/jpeg",
};
const securityHeaders = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

function sendJson(res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...securityHeaders,
  });
  res.end(JSON.stringify(value));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("请求必须是 JSON");
  }
}

function userCode(req) {
  const code = req.headers["x-radar-user-code"];
  return typeof code === "string" && isValidUserCode(code) ? code : null;
}

function cityExists(db, cityId) {
  return listCities(db).some((city) => city.id === cityId);
}

async function handleApi(req, res, url, db) {
  const { pathname, searchParams } = url;
  if (req.method === "GET" && pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, database: "sqlite", cities: listCities(db).length });
  }
  if (req.method === "GET" && pathname === "/api/cities") {
    return sendJson(res, 200, { cities: listCities(db) });
  }
  if (pathname === "/api/favorites") {
    const code = userCode(req);
    if (!code) return sendError(res, 401, "需要有效的跨设备收藏代码");
    if (req.method === "GET") return sendJson(res, 200, { favorites: listFavoriteIds(db, code) });
    const body = await readBody(req);
    if (req.method === "POST") {
      if (!cityExists(db, body.cityId) || typeof body.opportunityId !== "string") return sendError(res, 400, "收藏目标无效");
      if (!addFavorite(db, code, body.cityId, body.opportunityId)) return sendError(res, 404, "找不到该岗位");
      return sendJson(res, 201, { favorites: listFavoriteIds(db, code) });
    }
    if (req.method === "DELETE") {
      if (!cityExists(db, body.cityId) || typeof body.opportunityId !== "string") return sendError(res, 400, "收藏目标无效");
      removeFavorite(db, code, body.cityId, body.opportunityId);
      return sendJson(res, 200, { favorites: listFavoriteIds(db, code) });
    }
    return sendError(res, 405, "不支持的请求方法");
  }

  const match = pathname.match(/^\/api\/cities\/([a-z]+)\/(opportunities|sources|audit)$/);
  if (!match || req.method !== "GET") return sendError(res, 404, "未找到 API 接口");
  const [, cityId, resource] = match;
  if (!cityExists(db, cityId)) return sendError(res, 404, "未找到该城市");
  if (resource === "opportunities") {
    return sendJson(res, 200, {
      opportunities: listOpportunities(db, cityId, {
        track: searchParams.get("track"),
        q: searchParams.get("q"),
        recordType: searchParams.get("kind") === "monitor" ? "monitor" : "job",
      }),
    });
  }
  if (resource === "sources") {
    const view = searchParams.get("view") === "collection" ? "collection" : "shortcut";
    return sendJson(res, 200, { sources: listSources(db, cityId, view) });
  }
  return sendJson(res, 200, getCityAudit(db, cityId));
}

async function handleStatic(res, pathname) {
  const file = staticFiles.get(pathname);
  if (!file) return sendError(res, 404, "未找到页面");
  try {
    const body = await readFile(resolve(root, file));
    res.writeHead(200, {
      "content-type": contentTypes[extname(file)] ?? "application/octet-stream",
      // Pages and their small shared client bundle must move together.  A
      // cached app.js paired with freshly deployed HTML can prevent the app
      // from booting altogether, so let the browser revalidate every asset.
      "cache-control": "no-cache",
      "content-security-policy": "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'",
      ...securityHeaders,
    });
    res.end(body);
  } catch {
    sendError(res, 500, "页面资源不可用");
  }
}

export function createRadarServer({ databasePath = defaultDatabasePath(root) } = {}) {
  const db = openRadarDatabase(databasePath);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (url.pathname.startsWith("/api/")) await handleApi(req, res, url, db);
      else if (req.method === "GET" || req.method === "HEAD") await handleStatic(res, url.pathname);
      else sendError(res, 405, "不支持的请求方法");
    } catch (error) {
      if (!res.headersSent) sendError(res, 400, error instanceof Error ? error.message : "请求失败");
    }
  });
  return { server, db };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  const host = process.env.HOST ?? "127.0.0.1";
  const { server } = createRadarServer({ databasePath: process.env.RADAR_DB_PATH });
  server.listen(port, host, () => {
    console.log(`梦琳求职雷达服务已启动：http://${host}:${port}`);
  });
}
