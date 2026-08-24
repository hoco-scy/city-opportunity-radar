import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const CITY_CATALOG = [
  { id: "beijing", name: "北京", accent: "#143745", description: "国考、京考、选调优培、事业单位与央国企岗位" },
  { id: "shanghai", name: "上海", accent: "#b24e4e", description: "国考、沪考、选调优培、事业单位与央国企岗位" },
  { id: "guangzhou", name: "广州", accent: "#d08328", description: "国考、粤考、选调优培、事业单位与央国企岗位" },
  { id: "shenzhen", name: "深圳", accent: "#247c70", description: "国考、粤考、选调优培、事业单位与央国企岗位" },
];

const schema = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS cities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    accent TEXT NOT NULL,
    description TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS opportunities (
    city_id TEXT NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
    opportunity_id TEXT NOT NULL,
    record_type TEXT NOT NULL DEFAULT 'job',
    track TEXT NOT NULL,
    organization TEXT NOT NULL,
    title TEXT NOT NULL,
    exact_title TEXT,
    location TEXT,
    deadline TEXT,
    status TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    match_level TEXT,
    source_id TEXT,
    official_announcement_url TEXT,
    official_apply_url TEXT,
    verified_at TEXT,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (city_id, opportunity_id)
  );
  CREATE INDEX IF NOT EXISTS idx_opportunities_city_priority
    ON opportunities(city_id, priority DESC, verified_at DESC);
  CREATE INDEX IF NOT EXISTS idx_opportunities_city_track
    ON opportunities(city_id, track, priority DESC);
  CREATE TABLE IF NOT EXISTS sources (
    city_id TEXT NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL,
    organization TEXT NOT NULL,
    type TEXT,
    role TEXT,
    tier TEXT,
    cadence TEXT,
    coverage_json TEXT NOT NULL,
    entry_url TEXT NOT NULL,
    collection_entry_url TEXT,
    collection_access_mode TEXT,
    collection_note TEXT,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (city_id, source_id)
  );
  CREATE INDEX IF NOT EXISTS idx_sources_city_tier
    ON sources(city_id, tier, organization);
  CREATE TABLE IF NOT EXISTS sync_runs (
    city_id TEXT NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    status TEXT NOT NULL,
    outcome TEXT,
    scope TEXT,
    summary TEXT,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (city_id, run_id)
  );
  CREATE INDEX IF NOT EXISTS idx_sync_runs_city_checked
    ON sync_runs(city_id, checked_at DESC);
  CREATE TABLE IF NOT EXISTS source_checks (
    city_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    status TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    note TEXT,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (city_id, run_id, source_id),
    FOREIGN KEY (city_id, run_id) REFERENCES sync_runs(city_id, run_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_source_checks_city_source_checked
    ON source_checks(city_id, source_id, checked_at DESC);
  CREATE TABLE IF NOT EXISTS favorites (
    user_code_hash TEXT NOT NULL,
    city_id TEXT NOT NULL,
    opportunity_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_code_hash, city_id, opportunity_id),
    FOREIGN KEY (city_id, opportunity_id) REFERENCES opportunities(city_id, opportunity_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_favorites_user_created
    ON favorites(user_code_hash, created_at DESC);
  CREATE TABLE IF NOT EXISTS admin_accounts (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_used_at TEXT
  );
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    username TEXT NOT NULL REFERENCES admin_accounts(username) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires
    ON admin_sessions(expires_at);
  CREATE TABLE IF NOT EXISTS update_schedule (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
    timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    times_json TEXT NOT NULL DEFAULT '["09:00","14:00"]',
    updated_at TEXT NOT NULL,
    updated_by TEXT,
    last_triggered_at TEXT
  );
  CREATE TABLE IF NOT EXISTS update_runs (
    run_id TEXT PRIMARY KEY,
    trigger TEXT NOT NULL,
    requested_by TEXT,
    state TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    heartbeat_at TEXT NOT NULL,
    summary_json TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_update_runs_started
    ON update_runs(started_at DESC);
  CREATE TABLE IF NOT EXISTS update_events (
    run_id TEXT NOT NULL REFERENCES update_runs(run_id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    occurred_at TEXT NOT NULL,
    phase TEXT NOT NULL,
    level TEXT NOT NULL,
    city_id TEXT,
    source_id TEXT,
    message TEXT NOT NULL,
    data_json TEXT,
    PRIMARY KEY (run_id, sequence)
  );
  CREATE INDEX IF NOT EXISTS idx_update_events_run_time
    ON update_events(run_id, occurred_at, sequence);
  CREATE TABLE IF NOT EXISTS update_lock (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    run_id TEXT NOT NULL REFERENCES update_runs(run_id) ON DELETE CASCADE,
    acquired_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL
  );
`;

const forbiddenField = /^(candidateName|fullName|phone|email|birthDate|homeAddress|schoolName|studentId|idCard|portrait|avatar)$/i;
const phonePattern = /(?<!\d)1[3-9]\d{9}(?!\d)/;
const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
// Publication eligibility is based on verified official qualification fields.
// Job duties affect ranking in source-specific collectors; they never veto an
// otherwise eligible major merely because the title lacks a medical keyword.
const directProfessionalQualificationPattern = /(专业不限|不限专业|不限制专业|专业不作限制|可不限专业|不设专业限制|生物医学工程|生物医工|医学工程|医疗器械工程|临床工程|医疗电子|医学影像工程|生物工程|生物技术|生物医药|生命科学|生物科学|生物类|医疗器械(?:类|工程|相关专业)?)/;
// Broad terms must be complete qualification tokens.  Without boundaries,
// “软件工程类” accidentally matched the trailing “工程类” and was treated as
// if every engineering major were accepted.
const broadProfessionalQualificationPattern = /(?:^|[；;、，,\s/（(])(?:工学(?:门类|全类|大类|类|专业)?|所有工学|理工(?:科|类|专业|背景|方向)|工程(?:类|门类|学科))(?=$|[；;、，,\s/）)及等])/;
const professionalExclusionPattern = /(生物医学工程|生物医工|医学工程)(?:专业)?(?:除外|不(?:予|可|得)?报考|不接受|不招收)/;
const pureComputingRolePattern = /(网络安全|信息安全|前端|后端|软件(?:开发|工程师|工程)|算法工程师|人工智能工程师|AI工程师|大模型|云计算|数据(?:开发|工程师)|程序员)/i;
const biomedicalRoleBridgePattern = /(生物医学|医疗器械|医疗设备|医学影像|临床工程|体外诊断|IVD|生物信号|医学数据|智慧医疗|医疗软件|健康科技|生命科学)/i;

function itemText(item, fields) {
  return fields.flatMap((field) => Array.isArray(item[field]) ? item[field] : [item[field]])
    .filter(Boolean).join(" ");
}

export function isPubliclyDisplayableOpportunity(item) {
  if (!["央国企", "事业单位"].includes(item.track)) return true;
  if (!isProfileRelevantOpportunity(item)) return false;
  const verification = item.verification || {};
  const official = verification.officialSource === true && (verification.specificPosition === true || verification.exactTitle === true);
  const applicationPath = verification.applicationPath === true || Boolean(item.officialApplyUrl || item.officialAnnouncementUrl);
  return official && applicationPath;
}

export function isProfileRelevantOpportunity(item) {
  if (["考公", "选调优培"].includes(item.track)) return true;
  const qualification = itemText(item, ["majors", "requirements", "education"]);
  const verification = item.verification || {};
  if (professionalExclusionPattern.test(qualification) || verification.eligibility === false) return false;
  const eligible = verification.eligibility === true
    || directProfessionalQualificationPattern.test(qualification)
    || broadProfessionalQualificationPattern.test(qualification);
  if (!eligible) return false;
  const role = itemText(item, ["title", "exactTitle", "responsibilities", "duties", "description", "department"]);
  return !pureComputingRolePattern.test(role) || biomedicalRoleBridgePattern.test(role);
}

export function normalizePublicLocation(value) {
  if (value == null || value === "") return null;
  const parts = (Array.isArray(value) ? value : String(value).split(/[；;、，,]+/))
    .map((part) => String(part).replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const unique = [...new Set(parts)];
  const mostSpecific = unique.filter((part) => !unique.some((candidate) => candidate !== part && candidate.startsWith(part)));
  return (mostSpecific.length ? mostSpecific : unique).join("；") || null;
}

export function defaultDatabasePath(root = process.cwd()) {
  return resolve(root, ".data", "menglin-opportunity-radar.sqlite");
}

export function openRadarDatabase(filename = defaultDatabasePath()) {
  mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  // The web server, scheduler and CLI may touch the same database.  WAL keeps
  // readers responsive while BEGIN IMMEDIATE serializes update-lock changes;
  // busy_timeout lets a simultaneous trigger wait briefly and then observe the
  // existing lock instead of failing with SQLITE_BUSY.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(schema);
  const columns = db.prepare("PRAGMA table_info(opportunities)").all();
  if (!columns.some((column) => column.name === "record_type")) {
    db.exec("ALTER TABLE opportunities ADD COLUMN record_type TEXT NOT NULL DEFAULT 'job'");
  }
  db.prepare(`
    INSERT OR IGNORE INTO update_schedule (id, enabled, timezone, times_json, updated_at)
    VALUES (1, 0, 'Asia/Shanghai', '["09:00","14:00"]', ?)
  `).run(new Date().toISOString());
  db.exec("CREATE INDEX IF NOT EXISTS idx_opportunities_city_record_type_priority ON opportunities(city_id, record_type, priority DESC)");
  db.exec("PRAGMA optimize");
  return db;
}

export function closeDatabase(db) {
  db.close();
}

export function userCodeHash(code) {
  return createHash("sha256").update(code).digest("hex");
}

export function isValidUserCode(code) {
  // New identifiers are chosen and entered by the user. Keep accepting the
  // longer legacy mlr_ tokens so existing cross-device favorites do not
  // disappear after this migration.
  return typeof code === "string" && /^(?:[A-Za-z0-9][A-Za-z0-9_-]{5,63}|mlr_[A-Za-z0-9_-]{40,160})$/.test(code);
}

export function assertAnonymousPayload(value, path = "root") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertAnonymousPayload(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (forbiddenField.test(key)) throw new Error(`${path}.${key} 不是可公开导入字段`);
      assertAnonymousPayload(item, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === "string" && (phonePattern.test(value) || emailPattern.test(value))) {
    throw new Error(`${path} 包含疑似个人联系方式，拒绝导入`);
  }
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function opportunityRow(cityId, item, recordType) {
  const normalizedItem = { ...item, location: normalizePublicLocation(item.location) };
  return {
    cityId,
    opportunityId: String(item.id),
    recordType,
    track: item.track ?? "未分类",
    organization: item.organization ?? "官方未注明",
    title: item.title ?? item.exactTitle ?? "官方未注明岗位",
    exactTitle: item.exactTitle ?? null,
    location: normalizedItem.location,
    deadline: item.deadline ?? null,
    status: item.status ?? null,
    priority: Number.isFinite(item.priority) ? item.priority : 0,
    matchLevel: item.matchLevel ?? null,
    sourceId: item.sourceId ?? null,
    announcementUrl: item.officialAnnouncementUrl ?? null,
    applyUrl: item.officialApplyUrl ?? null,
    verifiedAt: item.verifiedAt ?? null,
    payload: json(normalizedItem),
  };
}

export function replaceCitySnapshot(db, { cityId, opportunities, registry, reviewLog, importedAt = new Date().toISOString() }) {
  const city = CITY_CATALOG.find((item) => item.id === cityId);
  if (!city) throw new Error(`未知城市：${cityId}`);
  assertAnonymousPayload(opportunities, "opportunities");
  assertAnonymousPayload(registry, "sourceRegistry");
  assertAnonymousPayload(reviewLog, "reviewLog");

  const insertCity = db.prepare(`
    INSERT INTO cities (id, name, accent, description, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, accent = excluded.accent,
      description = excluded.description, updated_at = excluded.updated_at
  `);
  const deleteSourceChecks = db.prepare("DELETE FROM source_checks WHERE city_id = ?");
  const deleteRuns = db.prepare("DELETE FROM sync_runs WHERE city_id = ?");
  const deleteSources = db.prepare("DELETE FROM sources WHERE city_id = ?");
  // Snapshot replacement cascades through favorites. Preserve favorites whose
  // stable opportunity IDs still exist in the incoming snapshot.
  const retainedFavorites = db.prepare(`
    SELECT user_code_hash, opportunity_id, created_at FROM favorites WHERE city_id = ?
  `).all(cityId);
  const deleteOpportunities = db.prepare("DELETE FROM opportunities WHERE city_id = ?");
  const insertOpportunity = db.prepare(`
    INSERT INTO opportunities (
      city_id, opportunity_id, record_type, track, organization, title, exact_title, location, deadline,
      status, priority, match_level, source_id, official_announcement_url, official_apply_url,
      verified_at, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSource = db.prepare(`
    INSERT INTO sources (
      city_id, source_id, organization, type, role, tier, cadence, coverage_json, entry_url,
      collection_entry_url, collection_access_mode, collection_note, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertRun = db.prepare(`
    INSERT INTO sync_runs (city_id, run_id, checked_at, status, outcome, scope, summary, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertCheck = db.prepare(`
    INSERT INTO source_checks (city_id, run_id, source_id, status, checked_at, note, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const opportunityExists = db.prepare("SELECT 1 FROM opportunities WHERE city_id = ? AND opportunity_id = ?");
  const restoreFavorite = db.prepare(`
    INSERT OR IGNORE INTO favorites (user_code_hash, city_id, opportunity_id, created_at)
    VALUES (?, ?, ?, ?)
  `);

  db.exec("BEGIN IMMEDIATE");
  try {
    insertCity.run(city.id, city.name, city.accent, city.description, importedAt);
    deleteSourceChecks.run(cityId);
    deleteRuns.run(cityId);
    deleteSources.run(cityId);
    deleteOpportunities.run(cityId);

    for (const [recordType, items] of [["job", opportunities.jobs ?? []], ["candidate", opportunities.candidates ?? []], ["monitor", opportunities.monitors ?? []]]) {
      for (const item of items) {
        if (recordType === "job" && !isPubliclyDisplayableOpportunity(item)) continue;
        if (recordType === "candidate" && !isProfileRelevantOpportunity(item)) continue;
        const row = opportunityRow(cityId, item, recordType);
        insertOpportunity.run(
          row.cityId, row.opportunityId, row.recordType, row.track, row.organization, row.title, row.exactTitle,
          row.location, row.deadline, row.status, row.priority, row.matchLevel, row.sourceId,
          row.announcementUrl, row.applyUrl, row.verifiedAt, row.payload,
        );
      }
    }
    for (const favorite of retainedFavorites) {
      if (opportunityExists.get(cityId, favorite.opportunity_id)) {
        restoreFavorite.run(favorite.user_code_hash, cityId, favorite.opportunity_id, favorite.created_at);
      }
    }

    for (const source of registry.sources ?? []) {
      insertSource.run(
        cityId, source.id, source.organization, source.type ?? null, source.role ?? null,
        source.tier ?? null, source.cadence ?? null, json(source.coverage ?? []), source.entryUrl,
        source.collectionEntryUrl ?? null, source.collectionAccessMode ?? source.accessMode ?? null,
        source.collectionNote ?? null, json(source),
      );
    }

    for (const run of reviewLog.runs ?? []) {
      const checkedAt = run.checkedAt ?? reviewLog.meta?.lastRunAt ?? importedAt;
      insertRun.run(
        cityId, run.id, checkedAt, run.status ?? "unknown", run.outcome ?? null,
        run.scope ?? null, run.summary ?? null, json(run),
      );
      for (const check of run.sourceChecks ?? []) {
        insertCheck.run(
          cityId, run.id, check.sourceId, check.status ?? "unknown", check.checkedAt ?? checkedAt,
          check.note ?? null, json(check),
        );
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function parsePayload(row) {
  return JSON.parse(row.payload_json);
}

const collectionMethodLabels = {
  "script-public-exam": "公务员考试公告、职位表与附件脚本",
  "script-official-notice-adapter": "官方公告列表、正文与附件脚本",
  "script-official-structured-list": "官网结构化筛选、分页与资格脚本",
  "script-official-public-gateway": "官网公开接口全量分页与资格脚本",
  "browser-spa": "官网原生筛选与岗位详情核验",
  "script-official-university-announcement-api": "北航就业网公开栏目、公告详情与附件核验",
  "server-rendered-list": "官网列表筛选与分页核验",
  "desktop-with-mobile-fallback": "官网招聘页与备用入口核验",
  "browser-official-page": "官网招聘页逐项核验",
  "filterable-dynamic-list": "官网筛选列表与岗位详情核验",
  "filterable-paginated-list": "官网筛选、分页与岗位详情核验",
  "semantic-health-check-required": "官网页面语义与招聘入口核验",
  "browser-antibot": "官网招聘入口人工浏览核验",
  "official-announcement-discovery": "官方公告发现与原文回溯",
  "public-filterable-list": "公开筛选列表与公告详情核验",
  "script-buaa-public-filtered-discovery": "北航就业信息网公开筛选脚本",
  "script-iguopin-public-filtered-discovery": "国聘公开筛选脚本",
  "script-ncss-public-filtered-discovery": "国家大学生就业服务平台公开筛选脚本",
  "script-jqzp-public-filtered-structured-list": "京企直聘北京应届国企岗位筛选脚本",
  "browser-platform-native-filter": "平台原生筛选与官方原文回溯",
  "unconfigured-route": "尚未配置自动采集路线",
};

export function listCities(db) {
  return db.prepare(`
    SELECT c.id, c.name, c.accent, c.description, c.updated_at,
      (SELECT COUNT(*) FROM opportunities o WHERE o.city_id = c.id AND o.record_type IN ('job', 'candidate')) AS opportunity_count,
      (SELECT MAX(checked_at) FROM sync_runs r WHERE r.city_id = c.id) AS last_checked_at
    FROM cities c
    ORDER BY CASE c.id
      WHEN 'beijing' THEN 1 WHEN 'shanghai' THEN 2 WHEN 'guangzhou' THEN 3 WHEN 'shenzhen' THEN 4 ELSE 99 END
  `).all();
}

export function listOpportunities(db, cityId, { track, q, recordType = "all" } = {}) {
  const conditions = ["city_id = ?"];
  const values = [cityId];
  if (recordType === "all") {
    conditions.push("record_type IN ('job', 'candidate')");
  } else {
    conditions.push("record_type = ?");
    values.push(recordType);
  }
  if (track && track !== "全部") {
    conditions.push("track = ?");
    values.push(track);
  }
  if (q) {
    conditions.push("(title LIKE ? OR organization LIKE ? OR exact_title LIKE ? OR payload_json LIKE ?)");
    const keyword = `%${q.trim().replace(/[%_]/g, "\\$&")}%`;
    values.push(keyword, keyword, keyword, keyword);
  }
  const rows = db.prepare(`
    SELECT record_type, payload_json FROM opportunities
    WHERE ${conditions.join(" AND ")}
    ORDER BY priority DESC, verified_at DESC, title ASC
  `).all(...values);
  return rows.map((row) => {
    const payload = parsePayload(row);
    if (row.record_type === "monitor") return payload;
    return {
      ...payload,
      recordType: row.record_type,
      evidenceStatus: row.record_type === "job" ? "official-verified" : "trusted-source",
      evidenceLabel: row.record_type === "job" ? "官方信息已核验" : "可信来源收录",
    };
  });
}

export function listSources(db, cityId, view = "shortcut") {
  const latestRun = db.prepare("SELECT run_id, checked_at FROM sync_runs WHERE city_id = ? ORDER BY checked_at DESC LIMIT 1").get(cityId);
  const rows = db.prepare(`
    SELECT s.*, (
      SELECT sc.payload_json FROM source_checks sc
      WHERE sc.city_id = s.city_id AND sc.source_id = s.source_id
      ORDER BY sc.checked_at DESC LIMIT 1
    ) AS latest_check_json, (
      SELECT sc.run_id FROM source_checks sc
      WHERE sc.city_id = s.city_id AND sc.source_id = s.source_id
      ORDER BY sc.checked_at DESC LIMIT 1
    ) AS latest_check_run_id
    FROM sources s WHERE s.city_id = ?
    ORDER BY CASE s.tier WHEN 'critical' THEN 1 WHEN 'high' THEN 2 ELSE 3 END, s.organization ASC
  `).all(cityId);
  return rows.map((row) => {
    const source = JSON.parse(row.payload_json);
    const check = row.latest_check_json ? JSON.parse(row.latest_check_json) : null;
    // A disabled source is intentionally out of the user's scope.  Do not
    // leave a stale official shortcut visible after it has been removed from
    // collection, otherwise the two source views communicate different rules.
    if (source.monitoringEnabled === false) return null;
    // Some low-relevance sources remain available to the collection workflow
    // as a backstop, but were deliberately removed from the user-facing quick
    // links. Keep those two roles independent.
    if (view === "shortcut" && source.shortcutEnabled === false) return null;
    if (view === "collection") {
      const accessMode = source.collectionAccessMode ?? source.accessMode ?? "unconfigured-route";
      return {
        id: source.id,
        // A source can have two deliberately different identities: the
        // government page users open directly and the public route the
        // collector actually runs.  The collection view must describe the
        // latter so that it never implies a government shortcut is scanned.
        organization: source.collectionOrganization ?? source.organization,
        type: source.collectionType ?? source.type,
        tier: source.tier,
        coverage: source.collectionCoverage ?? source.coverage ?? [],
        collectionEntryUrl: source.collectionEntryUrl ?? source.entryUrl,
        collectionMethod: collectionMethodLabels[accessMode] ?? "官网公开信息核验",
        collectionNote: source.collectionNote ?? null,
        shortcutOrganization: source.organization,
        latestCheck: check ? {
          checkedAt: check.checkedAt,
          isCurrent: row.latest_check_run_id === latestRun?.run_id,
          collectionMetrics: check.collectionMetrics ?? null,
        } : source.lastCollectionAudit ? {
          checkedAt: source.lastCollectionAudit.checkedAt,
          isCurrent: false,
          collectionMetrics: source.lastCollectionAudit.collectionMetrics ?? null,
        } : null,
      };
    }
    return {
      id: source.id,
      organization: source.organization,
      type: source.type,
      tier: source.tier,
      coverage: source.coverage ?? [],
      entryUrl: source.entryUrl,
      alternateEntryUrls: source.alternateEntryUrls ?? [],
    };
  }).filter(Boolean);
}

export function getCityAudit(db, cityId, limit = 10) {
  const runs = db.prepare(`
    SELECT payload_json FROM sync_runs WHERE city_id = ? ORDER BY checked_at DESC LIMIT ?
  `).all(cityId, limit).map(parsePayload);
  return { runs };
}

export function listFavoriteIds(db, code) {
  const hash = userCodeHash(code);
  return db.prepare(`
    SELECT city_id AS cityId, opportunity_id AS opportunityId, created_at AS createdAt
    FROM favorites WHERE user_code_hash = ? ORDER BY created_at DESC
  `).all(hash);
}

export function addFavorite(db, code, cityId, opportunityId) {
  const found = db.prepare(`
    SELECT 1 FROM opportunities WHERE city_id = ? AND opportunity_id = ?
  `).get(cityId, opportunityId);
  if (!found) return false;
  db.prepare(`
    INSERT OR IGNORE INTO favorites (user_code_hash, city_id, opportunity_id, created_at)
    VALUES (?, ?, ?, ?)
  `).run(userCodeHash(code), cityId, opportunityId, new Date().toISOString());
  return true;
}

export function removeFavorite(db, code, cityId, opportunityId) {
  db.prepare(`
    DELETE FROM favorites WHERE user_code_hash = ? AND city_id = ? AND opportunity_id = ?
  `).run(userCodeHash(code), cityId, opportunityId);
}

const adminUsernamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const adminSessionPattern = /^mas_[A-Za-z0-9_-]{32,160}$/;

function normalizeAdminUsername(username) {
  const value = typeof username === "string" ? username.trim() : "";
  if (!adminUsernamePattern.test(value)) throw new Error("管理员账号需为 3–64 位英文、数字、点、下划线或连字符");
  return value;
}

function normalizeAdminPassword(password) {
  if (typeof password !== "string" || password.length < 6 || password.length > 256) {
    throw new Error("管理员密码至少需为 6 个字符");
  }
  return password;
}

function passwordHash(password) {
  const salt = randomBytes(16).toString("base64url");
  const digest = scryptSync(password, salt, 64).toString("base64url");
  return `scrypt-v1:${salt}:${digest}`;
}

function passwordMatches(password, stored) {
  const [version, salt, digest] = String(stored).split(":");
  if (version !== "scrypt-v1" || !salt || !digest) return false;
  const expected = Buffer.from(digest, "base64url");
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function futureIso(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

export function isAdminConfigured(db) {
  return Number(db.prepare("SELECT COUNT(*) AS count FROM admin_accounts").get().count) > 0;
}

export function createAdminAccount(db, { username, password, replace = false } = {}) {
  const normalizedUsername = normalizeAdminUsername(username);
  const normalizedPassword = normalizeAdminPassword(password);
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT username FROM admin_accounts WHERE username = ?").get(normalizedUsername);
  if (existing && !replace) throw new Error("该管理员账号已经存在");
  if (existing) {
    db.prepare("UPDATE admin_accounts SET password_hash = ?, updated_at = ? WHERE username = ?")
      .run(passwordHash(normalizedPassword), now, normalizedUsername);
  } else {
    db.prepare("INSERT INTO admin_accounts (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(normalizedUsername, passwordHash(normalizedPassword), now, now);
  }
  return { username: normalizedUsername };
}

// Environment bootstrap is deliberately one-way: once an account exists,
// changing environment variables cannot reset it.  This makes deployment
// configuration safe to leave in place after first start.
export function ensureBootstrapAdmin(db, { username, password } = {}) {
  if (isAdminConfigured(db)) return false;
  if (!username && !password) return false;
  if (!username || !password) throw new Error("管理员初始化必须同时提供账号和密码");
  createAdminAccount(db, { username, password });
  return true;
}

export function createAdminSession(db, { username, password, hours = 12 } = {}) {
  const normalizedUsername = normalizeAdminUsername(username);
  const normalizedPassword = normalizeAdminPassword(password);
  const account = db.prepare("SELECT password_hash FROM admin_accounts WHERE username = ?").get(normalizedUsername);
  if (!account || !passwordMatches(normalizedPassword, account.password_hash)) throw new Error("管理员账号或密码不正确");
  const now = new Date().toISOString();
  const token = `mas_${randomBytes(32).toString("base64url")}`;
  const expiresAt = futureIso(hours);
  db.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").run(now);
  db.prepare("INSERT INTO admin_sessions (token_hash, username, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(tokenHash(token), normalizedUsername, now, expiresAt);
  db.prepare("UPDATE admin_accounts SET last_used_at = ? WHERE username = ?").run(now, normalizedUsername);
  return { token, username: normalizedUsername, expiresAt };
}

export function getAdminSession(db, token) {
  if (typeof token !== "string" || !adminSessionPattern.test(token)) return null;
  const now = new Date().toISOString();
  db.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").run(now);
  return db.prepare("SELECT username, expires_at AS expiresAt FROM admin_sessions WHERE token_hash = ? AND expires_at > ?")
    .get(tokenHash(token), now) ?? null;
}

export function revokeAdminSession(db, token) {
  if (typeof token !== "string" || !adminSessionPattern.test(token)) return;
  db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(tokenHash(token));
}

export function normalizeScheduleTimes(times) {
  if (!Array.isArray(times)) throw new Error("更新时间必须是数组");
  const normalized = [...new Set(times.map((value) => typeof value === "string" ? value.trim() : ""))].sort();
  if (!normalized.length || normalized.length > 8 || normalized.some((value) => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))) {
    throw new Error("请设置 1–8 个 HH:MM 格式的每日更新时间");
  }
  return normalized;
}

export function getUpdateSchedule(db) {
  const row = db.prepare(`
    SELECT enabled, timezone, times_json, updated_at, updated_by, last_triggered_at
    FROM update_schedule WHERE id = 1
  `).get();
  return {
    enabled: Boolean(row.enabled),
    timezone: row.timezone,
    times: normalizeScheduleTimes(JSON.parse(row.times_json)),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    lastTriggeredAt: row.last_triggered_at,
  };
}

export function saveUpdateSchedule(db, { enabled, times, updatedBy } = {}) {
  if (typeof enabled !== "boolean") throw new Error("请明确是否启用定时更新");
  const normalizedTimes = normalizeScheduleTimes(times);
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE update_schedule
    SET enabled = ?, timezone = 'Asia/Shanghai', times_json = ?, updated_at = ?, updated_by = ?
    WHERE id = 1
  `).run(enabled ? 1 : 0, json(normalizedTimes), now, updatedBy ?? null);
  return getUpdateSchedule(db);
}

export function markScheduleTriggered(db, triggeredAt = new Date().toISOString()) {
  db.prepare("UPDATE update_schedule SET last_triggered_at = ? WHERE id = 1").run(triggeredAt);
}

function updateRun(row) {
  if (!row) return null;
  return {
    runId: row.runId,
    trigger: row.trigger,
    requestedBy: row.requestedBy,
    state: row.state,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    heartbeatAt: row.heartbeatAt,
    summary: row.summaryJson ? JSON.parse(row.summaryJson) : null,
    error: row.error,
  };
}

const updateRunSelect = `
  SELECT run_id AS runId, trigger, requested_by AS requestedBy, state,
    started_at AS startedAt, completed_at AS completedAt, heartbeat_at AS heartbeatAt,
    summary_json AS summaryJson, error
  FROM update_runs
`;

export function getUpdateRun(db, runId) {
  if (typeof runId !== "string" || !runId) return null;
  return updateRun(db.prepare(`${updateRunSelect} WHERE run_id = ?`).get(runId));
}

export function getLatestUpdateRun(db) {
  return updateRun(db.prepare(`${updateRunSelect} ORDER BY started_at DESC LIMIT 1`).get());
}

export function getLockedUpdateRun(db) {
  return updateRun(db.prepare(`
    ${updateRunSelect}
    WHERE run_id = (SELECT run_id FROM update_lock WHERE id = 1)
  `).get());
}

export function appendUpdateEvent(db, runId, {
  phase,
  level = "info",
  cityId = null,
  sourceId = null,
  message,
  data = null,
  occurredAt = new Date().toISOString(),
} = {}) {
  if (typeof phase !== "string" || !phase || typeof message !== "string" || !message) {
    throw new Error("更新事件缺少阶段或事实说明");
  }
  const result = db.prepare(`
    INSERT INTO update_events (
      run_id, sequence, occurred_at, phase, level, city_id, source_id, message, data_json
    )
    SELECT ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ?, ?, ?, ?, ?
    FROM update_events WHERE run_id = ?
  `).run(runId, occurredAt, phase, level, cityId, sourceId, message.slice(0, 4_000), data == null ? null : json(data), runId);
  if (!result.changes) throw new Error("无法写入更新事件");
  const sequence = Number(db.prepare("SELECT MAX(sequence) AS sequence FROM update_events WHERE run_id = ?").get(runId).sequence);
  db.prepare("UPDATE update_runs SET heartbeat_at = ? WHERE run_id = ?").run(occurredAt, runId);
  db.prepare("UPDATE update_lock SET heartbeat_at = ? WHERE id = 1 AND run_id = ?").run(occurredAt, runId);
  return sequence;
}

export function listUpdateEvents(db, runId, { after = 0, limit = 500 } = {}) {
  const normalizedAfter = Math.max(0, Number.parseInt(after, 10) || 0);
  const normalizedLimit = Math.max(1, Math.min(500, Number.parseInt(limit, 10) || 500));
  return db.prepare(`
    SELECT sequence, occurred_at AS occurredAt, phase, level, city_id AS cityId,
      source_id AS sourceId, message, data_json AS dataJson
    FROM update_events WHERE run_id = ? AND sequence > ?
    ORDER BY sequence ASC LIMIT ?
  `).all(runId, normalizedAfter, normalizedLimit).map((row) => ({
    sequence: Number(row.sequence),
    occurredAt: row.occurredAt,
    phase: row.phase,
    level: row.level,
    cityId: row.cityId,
    sourceId: row.sourceId,
    message: row.message,
    data: row.dataJson ? JSON.parse(row.dataJson) : null,
  }));
}

export function heartbeatUpdateLock(db, runId, occurredAt = new Date().toISOString()) {
  db.prepare("UPDATE update_runs SET heartbeat_at = ? WHERE run_id = ? AND state = 'running'").run(occurredAt, runId);
  return Boolean(db.prepare("UPDATE update_lock SET heartbeat_at = ? WHERE id = 1 AND run_id = ?").run(occurredAt, runId).changes);
}

export function acquireUpdateLock(db, {
  runId,
  trigger,
  requestedBy = null,
  staleAfterMs = 5 * 60 * 1_000,
  now = new Date(),
} = {}) {
  if (typeof runId !== "string" || !runId || typeof trigger !== "string" || !trigger) throw new Error("更新锁参数不完整");
  const instant = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(instant.getTime())) throw new Error("更新锁时间无效");
  const nowIso = instant.toISOString();
  const staleBefore = new Date(instant.getTime() - staleAfterMs).toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const held = db.prepare("SELECT run_id AS runId, heartbeat_at AS heartbeatAt FROM update_lock WHERE id = 1").get();
    if (held && held.heartbeatAt > staleBefore) {
      db.exec("COMMIT");
      return { acquired: false, run: getUpdateRun(db, held.runId) };
    }
    if (held) {
      db.prepare(`
        UPDATE update_runs SET state = 'failed', completed_at = ?, heartbeat_at = ?,
          error = COALESCE(error, '服务心跳中断，旧更新锁已自动释放')
        WHERE run_id = ? AND state = 'running'
      `).run(nowIso, nowIso, held.runId);
      appendUpdateEvent(db, held.runId, {
        phase: "lock-expired",
        level: "error",
        message: "服务心跳中断，旧更新锁已自动释放。",
        occurredAt: nowIso,
      });
      db.prepare("DELETE FROM update_lock WHERE id = 1").run();
    }
    db.prepare(`
      INSERT INTO update_runs (
        run_id, trigger, requested_by, state, started_at, heartbeat_at
      ) VALUES (?, ?, ?, 'running', ?, ?)
    `).run(runId, trigger, requestedBy, nowIso, nowIso);
    db.prepare("INSERT INTO update_lock (id, run_id, acquired_at, heartbeat_at) VALUES (1, ?, ?, ?)")
      .run(runId, nowIso, nowIso);
    appendUpdateEvent(db, runId, {
      phase: "run-start",
      message: trigger.startsWith("schedule")
        ? "定时更新已取得更新锁，开始执行。"
        : trigger === "cli"
          ? "命令行更新已取得更新锁，开始执行。"
          : "管理员更新已取得更新锁，开始执行。",
      data: { trigger },
      occurredAt: nowIso,
    });
    db.exec("COMMIT");
    return { acquired: true, run: getUpdateRun(db, runId) };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function finishUpdateRun(db, runId, { state, summary = null, error = null, completedAt = new Date().toISOString() } = {}) {
  if (!["completed", "completed-partial", "failed"].includes(state)) throw new Error("更新结束状态无效");
  db.exec("BEGIN IMMEDIATE");
  try {
    appendUpdateEvent(db, runId, {
      phase: "run-finished",
      level: state === "failed" ? "error" : state === "completed-partial" ? "warning" : "success",
      message: state === "failed" ? `更新失败：${error || "未知错误"}` : state === "completed-partial" ? "更新部分完成，存在未导入城市。" : "四城更新已全部完成。",
      data: summary ? { importedCityCount: summary.importedCityCount, failedCityCount: summary.failedCityCount } : null,
      occurredAt: completedAt,
    });
    db.prepare(`
      UPDATE update_runs SET state = ?, completed_at = ?, heartbeat_at = ?, summary_json = ?, error = ?
      WHERE run_id = ?
    `).run(state, completedAt, completedAt, summary == null ? null : json(summary), error, runId);
    db.prepare("DELETE FROM update_lock WHERE id = 1 AND run_id = ?").run(runId);
    db.exec("COMMIT");
    return getUpdateRun(db, runId);
  } catch (finishError) {
    db.exec("ROLLBACK");
    throw finishError;
  }
}
