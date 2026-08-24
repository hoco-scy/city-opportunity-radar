import { createHash, randomUUID } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assertAnonymousPayload, openRadarDatabase } from "../db.mjs";
import { isDateWithinRetention, isOpportunityWithinRetention } from "../retention.mjs";

export const PUBLIC_DATA_FORMAT = "menglin-opportunity-radar-public-data";
export const PUBLIC_DATA_VERSION = 1;

const requiredDatabaseTables = [
  "cities",
  "opportunities",
  "sources",
  "sync_runs",
  "source_checks",
  "favorites",
  "admin_accounts",
  "admin_sessions",
  "update_schedule",
  "update_runs",
  "update_events",
  "update_lock",
];

async function exists(filename) {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:.]/g, "");
}

export function defaultTransferFilename(kind, directory, date = new Date()) {
  const suffix = kind === "public" ? "json" : "sqlite";
  return resolve(directory, `menglin-radar-${kind}-${safeTimestamp(date)}.${suffix}`);
}

async function sha256File(filename) {
  return createHash("sha256").update(await readFile(filename)).digest("hex");
}

async function removeDatabaseSidecars(filename) {
  await rm(`${filename}-wal`, { force: true });
  await rm(`${filename}-shm`, { force: true });
}

function count(db, table) {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
}

export function inspectDatabase(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check);
    if (integrity.length !== 1 || integrity[0] !== "ok") throw new Error(`数据库完整性检查失败：${integrity.join("；")}`);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => row.name));
    const missing = requiredDatabaseTables.filter((table) => !tables.has(table));
    if (missing.length) throw new Error(`数据库缺少必要数据表：${missing.join("、")}`);
    return {
      cities: count(db, "cities"),
      opportunities: count(db, "opportunities"),
      sources: count(db, "sources"),
      favorites: count(db, "favorites"),
      admins: count(db, "admin_accounts"),
      updateRuns: count(db, "update_runs"),
    };
  } finally {
    db.close();
  }
}

export async function exportDatabaseBackup({ source, output }) {
  const sourcePath = resolve(source);
  const outputPath = resolve(output);
  if (!(await exists(sourcePath))) throw new Error(`找不到数据库：${sourcePath}`);
  if (sourcePath === outputPath) throw new Error("备份文件不能覆盖正在使用的数据库");
  if (await exists(outputPath)) throw new Error(`备份文件已经存在：${outputPath}`);
  await mkdir(dirname(outputPath), { recursive: true });
  const db = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    // node:sqlite backup reads one transactionally consistent snapshot even
    // while the application database is using WAL mode.
    await backup(db, outputPath);
  } catch (error) {
    await rm(outputPath, { force: true });
    throw error;
  } finally {
    db.close();
  }
  await chmod(outputPath, 0o600);
  const summary = inspectDatabase(outputPath);
  await removeDatabaseSidecars(outputPath);
  const file = await stat(outputPath);
  return { kind: "full-database", output: outputPath, bytes: file.size, sha256: await sha256File(outputPath), summary };
}

async function prepareRestoreTarget(targetPath, confirmStopped) {
  if (!confirmStopped) throw new Error("恢复数据库前必须停止网页服务，并传入 --confirm-stopped");
  if (!(await exists(targetPath))) return;
  // A clean Docker stop can still leave WAL/SHM sidecars. After the caller has
  // explicitly confirmed that the web process is stopped, checkpoint them
  // into the main file. A busy checkpoint is treated as an active connection
  // and aborts the restore.
  const current = new DatabaseSync(targetPath);
  try {
    current.exec("PRAGMA busy_timeout = 1500");
    const checkpoint = current.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    const busy = Number(checkpoint.busy ?? Object.values(checkpoint)[0] ?? 0);
    if (busy !== 0) throw new Error("目标数据库仍处于繁忙状态，请确认所有网页服务实例已经停止");
  } finally {
    current.close();
  }
  await rm(`${targetPath}-wal`, { force: true });
  await rm(`${targetPath}-shm`, { force: true });
}

export async function restoreDatabaseBackup({ input, target, backupDirectory, confirmStopped = false }) {
  const inputPath = resolve(input);
  const targetPath = resolve(target);
  if (!(await exists(inputPath))) throw new Error(`找不到待恢复数据库：${inputPath}`);
  if (inputPath === targetPath) throw new Error("待恢复文件和目标数据库不能是同一个文件");
  const sourceSummary = inspectDatabase(inputPath);
  await removeDatabaseSidecars(inputPath);
  await prepareRestoreTarget(targetPath, confirmStopped);
  await mkdir(dirname(targetPath), { recursive: true });
  await mkdir(resolve(backupDirectory), { recursive: true });

  let previousBackup = null;
  if (await exists(targetPath)) {
    previousBackup = defaultTransferFilename("before-restore", backupDirectory);
    const current = new DatabaseSync(targetPath, { readOnly: true });
    try {
      await backup(current, previousBackup);
    } finally {
      current.close();
    }
    await chmod(previousBackup, 0o600);
    inspectDatabase(previousBackup);
    await removeDatabaseSidecars(previousBackup);
  }

  const temporary = `${targetPath}.restore-${randomUUID()}.tmp`;
  try {
    await copyFile(inputPath, temporary);
    await chmod(temporary, 0o600);
    inspectDatabase(temporary);
    await removeDatabaseSidecars(temporary);
    await rename(temporary, targetPath);
    const restoredSummary = inspectDatabase(targetPath);
    await removeDatabaseSidecars(targetPath);
    return { kind: "full-database", input: inputPath, target: targetPath, previousBackup, summary: restoredSummary, sourceSummary };
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function decodeRows(rows, jsonColumns = {}) {
  return rows.map((row) => {
    const decoded = { ...row };
    for (const [column, property] of Object.entries(jsonColumns)) {
      decoded[property] = JSON.parse(decoded[column]);
      delete decoded[column];
    }
    return decoded;
  });
}

function retainedOpportunityRow(row, now) {
  return isOpportunityWithinRetention({
    ...row.payload,
    verifiedAt: row.payload?.verifiedAt ?? row.verified_at,
  }, { now });
}

function publicDatasetFromDatabase(db) {
  db.exec("BEGIN");
  try {
    const now = new Date();
    const opportunities = decodeRows(db.prepare("SELECT city_id, opportunity_id, record_type, track, organization, title, exact_title, location, deadline, status, priority, match_level, source_id, official_announcement_url, official_apply_url, verified_at, payload_json FROM opportunities ORDER BY city_id, opportunity_id").all(), { payload_json: "payload" })
      .filter((row) => retainedOpportunityRow(row, now));
    const syncRuns = decodeRows(db.prepare("SELECT city_id, run_id, checked_at, status, outcome, scope, summary, payload_json FROM sync_runs ORDER BY city_id, checked_at, run_id").all(), { payload_json: "payload" })
      .filter((row) => isDateWithinRetention(row.checked_at, { now }));
    const retainedRunIds = new Set(syncRuns.map((row) => `${row.city_id}\u0000${row.run_id}`));
    const sourceChecks = decodeRows(db.prepare("SELECT city_id, run_id, source_id, status, checked_at, note, payload_json FROM source_checks ORDER BY city_id, run_id, source_id").all(), { payload_json: "payload" })
      .filter((row) => retainedRunIds.has(`${row.city_id}\u0000${row.run_id}`));
    const dataset = {
      format: PUBLIC_DATA_FORMAT,
      version: PUBLIC_DATA_VERSION,
      exportedAt: new Date().toISOString(),
      tables: {
        cities: db.prepare("SELECT id, name, accent, description, updated_at FROM cities ORDER BY id").all(),
        opportunities,
        sources: decodeRows(db.prepare("SELECT city_id, source_id, organization, type, role, tier, cadence, coverage_json, entry_url, collection_entry_url, collection_access_mode, collection_note, payload_json FROM sources ORDER BY city_id, source_id").all(), { coverage_json: "coverage", payload_json: "payload" }),
        syncRuns,
        sourceChecks,
      },
    };
    db.exec("COMMIT");
    return dataset;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction may already be closed */ }
    throw error;
  }
}

export async function exportPublicData({ source, output }) {
  const sourcePath = resolve(source);
  const outputPath = resolve(output);
  if (!(await exists(sourcePath))) throw new Error(`找不到数据库：${sourcePath}`);
  if (await exists(outputPath)) throw new Error(`公开数据包已经存在：${outputPath}`);
  const db = new DatabaseSync(sourcePath, { readOnly: true });
  let dataset;
  try {
    dataset = publicDatasetFromDatabase(db);
  } finally {
    db.close();
  }
  assertAnonymousPayload(dataset, "publicExport");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(dataset, null, 2)}\n`, { mode: 0o644 });
  const file = await stat(outputPath);
  return {
    kind: "public-data",
    output: outputPath,
    bytes: file.size,
    sha256: await sha256File(outputPath),
    summary: Object.fromEntries(Object.entries(dataset.tables).map(([name, rows]) => [name, rows.length])),
  };
}

function validatePublicDataset(dataset) {
  if (dataset?.format !== PUBLIC_DATA_FORMAT || dataset?.version !== PUBLIC_DATA_VERSION) throw new Error("不是受支持的梦琳求职雷达公开数据包");
  const required = ["cities", "opportunities", "sources", "syncRuns", "sourceChecks"];
  for (const table of required) if (!Array.isArray(dataset.tables?.[table])) throw new Error(`公开数据包缺少 ${table}`);
  assertAnonymousPayload(dataset, "publicImport");
}

export async function importPublicData({ input, target, confirmStopped = false }) {
  const inputPath = resolve(input);
  const targetPath = resolve(target);
  if (!(await exists(inputPath))) throw new Error(`找不到公开数据包：${inputPath}`);
  const dataset = JSON.parse(await readFile(inputPath, "utf8"));
  validatePublicDataset(dataset);
  await prepareRestoreTarget(targetPath, confirmStopped);
  const { cities, sources } = dataset.tables;
  const now = new Date();
  const opportunities = dataset.tables.opportunities.filter((row) => retainedOpportunityRow(row, now));
  const syncRuns = dataset.tables.syncRuns.filter((row) => isDateWithinRetention(row.checked_at, { now }));
  const retainedRunIds = new Set(syncRuns.map((row) => `${row.city_id}\u0000${row.run_id}`));
  const sourceChecks = dataset.tables.sourceChecks.filter((row) => retainedRunIds.has(`${row.city_id}\u0000${row.run_id}`));
  const db = openRadarDatabase(targetPath);
  const retainedFavorites = db.prepare("SELECT user_code_hash, city_id, opportunity_id, created_at FROM favorites").all();
  const insertCity = db.prepare("INSERT INTO cities (id, name, accent, description, updated_at) VALUES (?, ?, ?, ?, ?)");
  const insertOpportunity = db.prepare("INSERT INTO opportunities (city_id, opportunity_id, record_type, track, organization, title, exact_title, location, deadline, status, priority, match_level, source_id, official_announcement_url, official_apply_url, verified_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const insertSource = db.prepare("INSERT INTO sources (city_id, source_id, organization, type, role, tier, cadence, coverage_json, entry_url, collection_entry_url, collection_access_mode, collection_note, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const insertRun = db.prepare("INSERT INTO sync_runs (city_id, run_id, checked_at, status, outcome, scope, summary, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const insertCheck = db.prepare("INSERT INTO source_checks (city_id, run_id, source_id, status, checked_at, note, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const opportunityExists = db.prepare("SELECT 1 FROM opportunities WHERE city_id = ? AND opportunity_id = ?");
  const restoreFavorite = db.prepare("INSERT OR IGNORE INTO favorites (user_code_hash, city_id, opportunity_id, created_at) VALUES (?, ?, ?, ?)");

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM source_checks; DELETE FROM sync_runs; DELETE FROM sources; DELETE FROM opportunities; DELETE FROM cities;");
    for (const row of cities) insertCity.run(row.id, row.name, row.accent, row.description, row.updated_at);
    for (const row of opportunities) insertOpportunity.run(row.city_id, row.opportunity_id, row.record_type, row.track, row.organization, row.title, row.exact_title, row.location, row.deadline, row.status, row.priority, row.match_level, row.source_id, row.official_announcement_url, row.official_apply_url, row.verified_at, JSON.stringify(row.payload));
    for (const favorite of retainedFavorites) if (opportunityExists.get(favorite.city_id, favorite.opportunity_id)) restoreFavorite.run(favorite.user_code_hash, favorite.city_id, favorite.opportunity_id, favorite.created_at);
    for (const row of sources) insertSource.run(row.city_id, row.source_id, row.organization, row.type, row.role, row.tier, row.cadence, JSON.stringify(row.coverage), row.entry_url, row.collection_entry_url, row.collection_access_mode, row.collection_note, JSON.stringify(row.payload));
    for (const row of syncRuns) insertRun.run(row.city_id, row.run_id, row.checked_at, row.status, row.outcome, row.scope, row.summary, JSON.stringify(row.payload));
    for (const row of sourceChecks) insertCheck.run(row.city_id, row.run_id, row.source_id, row.status, row.checked_at, row.note, JSON.stringify(row.payload));
    db.exec("COMMIT");
    db.exec("PRAGMA optimize");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction may already be closed */ }
    throw error;
  } finally {
    db.close();
  }
  return {
    kind: "public-data",
    input: inputPath,
    target: targetPath,
    preservedFavorites: retainedFavorites.filter((favorite) => opportunities.some((row) => row.city_id === favorite.city_id && row.opportunity_id === favorite.opportunity_id)).length,
    summary: { cities: cities.length, opportunities: opportunities.length, sources: sources.length, syncRuns: syncRuns.length, sourceChecks: sourceChecks.length },
  };
}
