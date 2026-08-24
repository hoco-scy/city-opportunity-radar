#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabase, defaultDatabasePath, openRadarDatabase, prunePublicRetention } from "../db.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

const databasePath = resolve(argument("--database") ?? process.env.RADAR_DB_PATH ?? defaultDatabasePath(projectRoot));
const nowArgument = argument("--now");
const now = nowArgument ? new Date(nowArgument) : new Date();
const db = openRadarDatabase(databasePath);
try {
  console.log(JSON.stringify(prunePublicRetention(db, { now }), null, 2));
} finally {
  closeDatabase(db);
}
