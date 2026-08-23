import { createHash } from "node:crypto";
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
`;

const forbiddenField = /^(candidateName|fullName|phone|email|birthDate|homeAddress|schoolName|studentId|idCard|portrait|avatar)$/i;
const phonePattern = /(?<!\d)1[3-9]\d{9}(?!\d)/;
const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
// Public job cards are intentionally stricter than discovery.  A company
// name, an open-major statement, or generic engineering experience is not a
// substitute for evidence that both the profession and the work itself fit
// the public biomedical-engineering scope.
const biomedicalQualificationPattern = /(生物医学工程|生物医工|医学工程|医疗器械工程|临床工程|医疗电子|医学影像(?:工程|技术)?|生物工程)/;
const broadEngineeringPattern = /(?:工学(?:门类)?|工程类|理工(?:科)?类|仪器(?:科学)?与技术)/;
const biomedicalRolePattern = /(医疗器械|医学影像|生物信号|临床工程|医疗电子|体外诊断|智慧医疗|医疗健康|临床数据|医学数据|数字医疗|生物医药|生命科学|健康科技)/;

function itemText(item, fields) {
  return fields.flatMap((field) => Array.isArray(item[field]) ? item[field] : [item[field]])
    .filter(Boolean).join(" ");
}

export function isPubliclyDisplayableOpportunity(item) {
  if (!["央国企", "事业单位"].includes(item.track)) return true;
  const qualification = itemText(item, ["majors", "requirements", "education"]);
  const role = itemText(item, ["title", "exactTitle", "responsibilities", "tags", "organization"]);
  // Exact related-major evidence is sufficient only when the actual role has
  // an adjacent biomedical/health scenario.  A broad engineering allowance
  // is sufficient only together with the same scenario evidence.
  const hasRoleBridge = biomedicalRolePattern.test(role);
  return hasRoleBridge && (biomedicalQualificationPattern.test(qualification) || broadEngineeringPattern.test(qualification));
}

export function defaultDatabasePath(root = process.cwd()) {
  return resolve(root, ".data", "menglin-opportunity-radar.sqlite");
}

export function openRadarDatabase(filename = defaultDatabasePath()) {
  mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(schema);
  const columns = db.prepare("PRAGMA table_info(opportunities)").all();
  if (!columns.some((column) => column.name === "record_type")) {
    db.exec("ALTER TABLE opportunities ADD COLUMN record_type TEXT NOT NULL DEFAULT 'job'");
  }
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
  return typeof code === "string" && /^mlr_[A-Za-z0-9_-]{40,160}$/.test(code);
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
  return {
    cityId,
    opportunityId: String(item.id),
    recordType,
    track: item.track ?? "未分类",
    organization: item.organization ?? "官方未注明",
    title: item.title ?? item.exactTitle ?? "官方未注明岗位",
    exactTitle: item.exactTitle ?? null,
    location: item.location ?? null,
    deadline: item.deadline ?? null,
    status: item.status ?? null,
    priority: Number.isFinite(item.priority) ? item.priority : 0,
    matchLevel: item.matchLevel ?? null,
    sourceId: item.sourceId ?? null,
    announcementUrl: item.officialAnnouncementUrl ?? null,
    applyUrl: item.officialApplyUrl ?? null,
    verifiedAt: item.verifiedAt ?? null,
    payload: json(item),
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

  db.exec("BEGIN IMMEDIATE");
  try {
    insertCity.run(city.id, city.name, city.accent, city.description, importedAt);
    deleteSourceChecks.run(cityId);
    deleteRuns.run(cityId);
    deleteSources.run(cityId);
    deleteOpportunities.run(cityId);

    for (const [recordType, items] of [["job", opportunities.jobs ?? []], ["monitor", opportunities.monitors ?? []]]) {
      for (const item of items) {
        if (recordType === "job" && !isPubliclyDisplayableOpportunity(item)) continue;
        const row = opportunityRow(cityId, item, recordType);
        insertOpportunity.run(
          row.cityId, row.opportunityId, row.recordType, row.track, row.organization, row.title, row.exactTitle,
          row.location, row.deadline, row.status, row.priority, row.matchLevel, row.sourceId,
          row.announcementUrl, row.applyUrl, row.verifiedAt, row.payload,
        );
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
  "script-buaa-public-filtered-discovery": "北航公开筛选脚本（线索待回溯）",
  "browser-platform-native-filter": "平台原生筛选与官方原文回溯",
};

export function listCities(db) {
  return db.prepare(`
    SELECT c.id, c.name, c.accent, c.description, c.updated_at,
      (SELECT COUNT(*) FROM opportunities o WHERE o.city_id = c.id) AS opportunity_count,
      (SELECT MAX(checked_at) FROM sync_runs r WHERE r.city_id = c.id) AS last_checked_at
    FROM cities c
    ORDER BY CASE c.id
      WHEN 'beijing' THEN 1 WHEN 'shanghai' THEN 2 WHEN 'guangzhou' THEN 3 WHEN 'shenzhen' THEN 4 ELSE 99 END
  `).all();
}

export function listOpportunities(db, cityId, { track, q, recordType = "job" } = {}) {
  const conditions = ["city_id = ?"];
  const values = [cityId];
  if (recordType !== "all") {
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
    SELECT payload_json FROM opportunities
    WHERE ${conditions.join(" AND ")}
    ORDER BY priority DESC, verified_at DESC, title ASC
  `).all(...values);
  return rows.map(parsePayload);
}

export function listSources(db, cityId, view = "shortcut") {
  const latestRun = db.prepare("SELECT MAX(checked_at) AS checked_at FROM sync_runs WHERE city_id = ?").get(cityId);
  const rows = db.prepare(`
    SELECT s.*, (
      SELECT sc.payload_json FROM source_checks sc
      WHERE sc.city_id = s.city_id AND sc.source_id = s.source_id
      ORDER BY sc.checked_at DESC LIMIT 1
    ) AS latest_check_json
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
    if (view === "collection") {
      const accessMode = source.collectionAccessMode ?? source.accessMode;
      if (!accessMode) return null;
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
          isCurrent: check.checkedAt === latestRun?.checked_at,
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
