import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  addFavorite,
  createAdminAccount,
  getUpdateSchedule,
  listFavoriteIds,
  openRadarDatabase,
  saveUpdateSchedule,
} from "../db.mjs";
import { importLegacyCities } from "../scripts/import-legacy-cities.mjs";
import {
  exportDatabaseBackup,
  exportPublicData,
  importPublicData,
  inspectDatabase,
  restoreDatabaseBackup,
} from "../scripts/database-transfer.mjs";

const projectRoot = resolve(new URL("../", import.meta.url).pathname);
const legacyRoot = resolve(projectRoot, "..");
const userIdentifier = "transfer_test_user";

async function createPopulatedDatabase(filename, adminUsername = "backup-admin") {
  await importLegacyCities({ legacyRoot, databasePath: filename });
  const db = openRadarDatabase(filename);
  const job = db.prepare("SELECT city_id, opportunity_id FROM opportunities ORDER BY city_id, opportunity_id LIMIT 1").get();
  createAdminAccount(db, { username: adminUsername, password: "test-only-password" });
  assert.equal(addFavorite(db, userIdentifier, job.city_id, job.opportunity_id), true);
  saveUpdateSchedule(db, { enabled: true, times: ["09:00", "14:00"], updatedBy: adminUsername });
  db.close();
  return job;
}

test("exports a consistent full backup and restores it only after the service is stopped", async (t) => {
  const workdir = await mkdtemp(join(tmpdir(), "menglin-radar-full-transfer-"));
  t.after(() => rm(workdir, { recursive: true, force: true }));
  const source = join(workdir, "source.sqlite");
  const output = join(workdir, "backups", "full.sqlite");
  const target = join(workdir, "target.sqlite");
  const backupDirectory = join(workdir, "backups");
  const favorite = await createPopulatedDatabase(source);
  await createPopulatedDatabase(target, "old-admin");

  const exported = await exportDatabaseBackup({ source, output });
  assert.equal(exported.summary.cities, 4);
  assert.equal(exported.summary.favorites, 1);
  assert.equal(exported.summary.admins, 1);
  assert.match(exported.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(() => stat(`${output}-wal`), { code: "ENOENT" });
  await assert.rejects(() => stat(`${output}-shm`), { code: "ENOENT" });
  await assert.rejects(() => restoreDatabaseBackup({ input: output, target, backupDirectory }), /--confirm-stopped/);

  const restored = await restoreDatabaseBackup({ input: output, target, backupDirectory, confirmStopped: true });
  assert.ok(restored.previousBackup);
  await assert.rejects(() => stat(`${target}-wal`), { code: "ENOENT" });
  await assert.rejects(() => stat(`${target}-shm`), { code: "ENOENT" });
  assert.equal(inspectDatabase(restored.previousBackup).admins, 1);
  assert.deepEqual(inspectDatabase(target), inspectDatabase(output));
  const db = openRadarDatabase(target);
  assert.equal(db.prepare("SELECT username FROM admin_accounts").get().username, "backup-admin");
  assert.deepEqual(listFavoriteIds(db, userIdentifier).map((item) => [item.cityId, item.opportunityId]), [[favorite.city_id, favorite.opportunity_id]]);
  assert.deepEqual(getUpdateSchedule(db).times, ["09:00", "14:00"]);
  db.close();
});

test("exports and imports public data without moving private control data", async (t) => {
  const workdir = await mkdtemp(join(tmpdir(), "menglin-radar-public-transfer-"));
  t.after(() => rm(workdir, { recursive: true, force: true }));
  const source = join(workdir, "source.sqlite");
  const target = join(workdir, "target.sqlite");
  const output = join(workdir, "public.json");
  const targetFavorite = await createPopulatedDatabase(target, "target-admin");
  await createPopulatedDatabase(source, "source-admin");

  const exported = await exportPublicData({ source, output });
  assert.equal(exported.summary.cities, 4);
  const dataset = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(Object.keys(dataset.tables).sort(), ["cities", "opportunities", "sourceChecks", "sources", "syncRuns"].sort());
  assert.equal(JSON.stringify(dataset).includes("password_hash"), false);
  assert.equal(JSON.stringify(dataset).includes("user_code_hash"), false);

  await assert.rejects(() => importPublicData({ input: output, target }), /--confirm-stopped/);
  const imported = await importPublicData({ input: output, target, confirmStopped: true });
  assert.equal(imported.preservedFavorites, 1);
  const db = openRadarDatabase(target);
  assert.equal(db.prepare("SELECT username FROM admin_accounts").get().username, "target-admin");
  assert.deepEqual(listFavoriteIds(db, userIdentifier).map((item) => [item.cityId, item.opportunityId]), [[targetFavorite.city_id, targetFavorite.opportunity_id]]);
  assert.equal(getUpdateSchedule(db).updatedBy, "target-admin");
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM cities").get().count), 4);
  db.close();
});
