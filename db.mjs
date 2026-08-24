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
  CREATE TABLE IF NOT EXISTS candidate_reviews (
    city_id TEXT NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
    candidate_id TEXT NOT NULL,
    decision TEXT NOT NULL CHECK(decision IN ('approved', 'rejected')),
    reviewer_username TEXT NOT NULL REFERENCES admin_accounts(username),
    reviewed_at TEXT NOT NULL,
    note TEXT,
    approved_opportunity_id TEXT,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (city_id, candidate_id)
  );
  CREATE INDEX IF NOT EXISTS idx_candidate_reviews_city_decision
    ON candidate_reviews(city_id, decision, reviewed_at DESC);
`;

const forbiddenField = /^(candidateName|fullName|phone|email|birthDate|homeAddress|schoolName|studentId|idCard|portrait|avatar)$/i;
const phonePattern = /(?<!\d)1[3-9]\d{9}(?!\d)/;
const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
// Publication eligibility is based on verified official qualification fields.
// Job duties affect ranking in source-specific collectors; they never veto an
// otherwise eligible major merely because the title lacks a medical keyword.
const professionalQualificationPattern = /(专业不限|不限专业|不限制专业|专业不作限制|可不限专业|不设专业限制|生物医学工程|生物医工|医学工程|医疗器械工程|临床工程|医疗电子|医学影像工程|生物工程|生物技术|生物医药|生命科学|生物科学|生物类|医疗器械(?:类|工程|相关专业)?|工学(?:门类|全类|类|专业)|所有工学|理工(?:科|类|专业|背景|方向|等|及|、|，|\/|$)|工程(?:类|门类|学科))/;
const professionalExclusionPattern = /(生物医学工程|生物医工|医学工程)(?:专业)?(?:除外|不(?:予|可|得)?报考|不接受|不招收)/;

function itemText(item, fields) {
  return fields.flatMap((field) => Array.isArray(item[field]) ? item[field] : [item[field]])
    .filter(Boolean).join(" ");
}

export function isPubliclyDisplayableOpportunity(item) {
  if (!["央国企", "事业单位"].includes(item.track)) return true;
  const qualification = itemText(item, ["majors", "requirements", "education"]);
  const verification = item.verification || {};
  if (professionalExclusionPattern.test(qualification) || verification.eligibility === false) return false;
  const official = verification.officialSource === true && (verification.specificPosition === true || verification.exactTitle === true);
  const applicationPath = verification.applicationPath === true || Boolean(item.officialApplyUrl || item.officialAnnouncementUrl);
  const eligible = verification.eligibility === true || professionalQualificationPattern.test(qualification);
  return official && applicationPath && eligible;
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
  // Manually approved jobs live in the same public table but are not derived
  // from a city snapshot.  Keep them through a scheduled re-import.
  const deleteOpportunities = db.prepare("DELETE FROM opportunities WHERE city_id = ? AND COALESCE(source_id, '') != 'admin-review'");
  const reviewedCandidate = db.prepare("SELECT 1 FROM candidate_reviews WHERE city_id = ? AND candidate_id = ?");
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

    for (const [recordType, items] of [["job", opportunities.jobs ?? []], ["candidate", opportunities.candidates ?? []], ["monitor", opportunities.monitors ?? []]]) {
      for (const item of items) {
        if (recordType === "job" && !isPubliclyDisplayableOpportunity(item)) continue;
        // Once an administrator has approved or rejected a platform lead, it
        // must not silently return to the pending queue on the next scan.
        if (recordType === "candidate" && reviewedCandidate.get(cityId, String(item.id))) continue;
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
  "script-buaa-public-filtered-discovery": "北航公开筛选脚本（待用户确认线索）",
  "script-iguopin-public-filtered-discovery": "国聘公开筛选脚本（待用户确认线索）",
  "script-ncss-public-filtered-discovery": "国家大学生就业服务平台公开筛选脚本（待用户确认线索）",
  "browser-platform-native-filter": "平台原生筛选与官方原文回溯",
  "unconfigured-route": "尚未配置自动采集路线",
};

export function listCities(db) {
  return db.prepare(`
    SELECT c.id, c.name, c.accent, c.description, c.updated_at,
      (SELECT COUNT(*) FROM opportunities o WHERE o.city_id = c.id AND o.record_type = 'job') AS opportunity_count,
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
          isCurrent: check.checkedAt === latestRun?.checked_at,
          collectionMetrics: check.collectionMetrics ?? null,
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

function textField(value, label, { required = true, max = 2_000 } = {}) {
  const text = typeof value === "string" ? value.trim() : "";
  if (required && !text) throw new Error(`请填写${label}`);
  if (text.length > max) throw new Error(`${label}过长`);
  return text || null;
}

function urlField(value, label, { required = true } = {}) {
  const text = textField(value, label, { required, max: 2_000 });
  if (!text) return null;
  let parsed;
  try { parsed = new URL(text); } catch { throw new Error(`${label}不是有效网址`); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`${label}必须使用 http 或 https`);
  return parsed.toString();
}

function lines(value, label) {
  const text = textField(value, label);
  const result = text.split(/\r?\n|；|;/).map((item) => item.trim()).filter(Boolean);
  if (!result.length) throw new Error(`请填写${label}`);
  return result.slice(0, 30);
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

function manualOpportunityId(cityId, candidateId) {
  return `admin-verified-${createHash("sha256").update(`${cityId}:${candidateId}`).digest("hex").slice(0, 20)}`;
}

function reviewPayload(candidate, details, now) {
  const track = textField(details.track, "岗位类别", { max: 24 });
  if (!["考公", "选调优培", "央国企", "事业单位"].includes(track)) throw new Error("岗位类别不正确");
  if (details.activeConfirmed !== true) throw new Error("请确认该岗位仍在有效期内或属于仍有效的预公告");
  const opportunity = {
    exactTitle: textField(details.exactTitle ?? candidate.exactTitle ?? candidate.title, "具体岗位名称"),
    title: textField(details.exactTitle ?? candidate.exactTitle ?? candidate.title, "具体岗位名称"),
    organization: textField(details.organization ?? candidate.organization, "招录单位"),
    location: textField(details.location ?? candidate.location, "工作地点"),
    deadline: textField(details.deadline ?? candidate.deadline, "报名或公告有效期"),
    education: textField(details.education ?? candidate.education, "学历要求"),
    majors: textField(details.majors ?? candidate.majors, "专业要求"),
    responsibilities: lines(details.responsibilities, "岗位职责"),
    requirements: lines(details.requirements, "其他报考条件"),
    officialAnnouncementUrl: urlField(details.officialAnnouncementUrl, "官方公告链接"),
    officialApplyUrl: urlField(details.officialApplyUrl, "官方报名或投递链接", { required: false }),
    status: textField(details.status ?? "招聘中", "岗位状态", { max: 40 }),
    matchReason: textField(details.matchReason, "收录理由", { max: 1_000 }),
    jobCode: textField(details.jobCode, "岗位代码", { required: false, max: 200 }),
    priority: Math.max(0, Math.min(100, Number.parseInt(details.priority, 10) || Number(candidate.priority) || 60)),
    track,
    matchLevel: "已核验",
    sourceId: "admin-review",
    verifiedAt: now,
    tags: [...new Set([...(Array.isArray(candidate.tags) ? candidate.tags : []), "管理员核验", track])].slice(0, 10),
    verification: {
      officialSource: true,
      exactTitle: true,
      organization: true,
      location: true,
      deadline: true,
      education: true,
      majors: true,
      responsibilities: true,
      requirements: true,
      activeConfirmed: true,
    },
  };
  if (!opportunity.officialApplyUrl) opportunity.officialApplyUrl = opportunity.officialAnnouncementUrl;
  return opportunity;
}

export function reviewCandidate(db, { cityId, candidateId, reviewerUsername, decision, details = {} } = {}) {
  if (!["approved", "rejected"].includes(decision)) throw new Error("审核结论不正确");
  const candidate = db.prepare("SELECT payload_json FROM opportunities WHERE city_id = ? AND opportunity_id = ? AND record_type = 'candidate'")
    .get(cityId, candidateId);
  if (!candidate) throw new Error("该待确认线索不存在，或已经完成审核");
  const item = parsePayload(candidate);
  const now = new Date().toISOString();
  const note = textField(details.note, "审核说明", { required: decision === "rejected", max: 2_000 });
  let published = null;

  db.exec("BEGIN IMMEDIATE");
  try {
    if (decision === "approved") {
      const publicItem = reviewPayload(item, details, now);
      publicItem.id = manualOpportunityId(cityId, candidateId);
      assertAnonymousPayload(publicItem, "管理员核验岗位");
      if (!isPubliclyDisplayableOpportunity(publicItem)) {
        throw new Error("央国企或事业单位岗位缺少官方具体岗位、投递路径或生物医学工程可报的专业资格依据，不能发布");
      }
      const row = opportunityRow(cityId, publicItem, "job");
      db.prepare(`
        INSERT INTO opportunities (
          city_id, opportunity_id, record_type, track, organization, title, exact_title, location, deadline,
          status, priority, match_level, source_id, official_announcement_url, official_apply_url,
          verified_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(city_id, opportunity_id) DO UPDATE SET
          track = excluded.track, organization = excluded.organization, title = excluded.title,
          exact_title = excluded.exact_title, location = excluded.location, deadline = excluded.deadline,
          status = excluded.status, priority = excluded.priority, match_level = excluded.match_level,
          official_announcement_url = excluded.official_announcement_url,
          official_apply_url = excluded.official_apply_url, verified_at = excluded.verified_at,
          payload_json = excluded.payload_json
      `).run(
        row.cityId, row.opportunityId, row.recordType, row.track, row.organization, row.title, row.exactTitle,
        row.location, row.deadline, row.status, row.priority, row.matchLevel, row.sourceId,
        row.announcementUrl, row.applyUrl, row.verifiedAt, row.payload,
      );
      db.prepare("UPDATE favorites SET opportunity_id = ? WHERE city_id = ? AND opportunity_id = ?")
        .run(publicItem.id, cityId, candidateId);
      published = publicItem;
    }
    db.prepare(`
      INSERT INTO candidate_reviews (
        city_id, candidate_id, decision, reviewer_username, reviewed_at, note, approved_opportunity_id, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(city_id, candidate_id) DO UPDATE SET
        decision = excluded.decision, reviewer_username = excluded.reviewer_username, reviewed_at = excluded.reviewed_at,
        note = excluded.note, approved_opportunity_id = excluded.approved_opportunity_id, payload_json = excluded.payload_json
    `).run(
      cityId, candidateId, decision, reviewerUsername, now, note, published?.id ?? null,
      json({ decision, reviewedAt: now, note, approvedOpportunityId: published?.id ?? null }),
    );
    db.prepare("DELETE FROM opportunities WHERE city_id = ? AND opportunity_id = ? AND record_type = 'candidate'")
      .run(cityId, candidateId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { decision, reviewedAt: now, opportunity: published };
}
