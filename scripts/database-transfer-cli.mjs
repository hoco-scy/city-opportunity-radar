#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDatabasePath } from "../db.mjs";
import {
  defaultTransferFilename,
  exportDatabaseBackup,
  exportPublicData,
  importPublicData,
  restoreDatabaseBackup,
} from "./database-transfer.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const action = process.argv[2];

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

const database = resolve(argument("--database") ?? process.env.RADAR_DB_PATH ?? defaultDatabasePath(projectRoot));
const transferDirectory = resolve(argument("--backup-dir") ?? process.env.RADAR_BACKUP_DIR ?? resolve(projectRoot, "backups"));

let result;
if (action === "export") {
  result = await exportDatabaseBackup({ source: database, output: resolve(argument("--output") ?? defaultTransferFilename("full", transferDirectory)) });
} else if (action === "restore") {
  const input = argument("--input");
  if (!input) throw new Error("完整恢复需要 --input <备份数据库>");
  result = await restoreDatabaseBackup({ input, target: database, backupDirectory: transferDirectory, confirmStopped: hasFlag("--confirm-stopped") });
} else if (action === "export-public") {
  result = await exportPublicData({ source: database, output: resolve(argument("--output") ?? defaultTransferFilename("public", transferDirectory)) });
} else if (action === "import-public") {
  const input = argument("--input");
  if (!input) throw new Error("公开数据导入需要 --input <JSON 数据包>");
  result = await importPublicData({ input, target: database, confirmStopped: hasFlag("--confirm-stopped") });
} else {
  throw new Error("可用操作：export、restore、export-public、import-public");
}

console.log(JSON.stringify(result, null, 2));
