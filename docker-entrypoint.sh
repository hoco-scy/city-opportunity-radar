#!/bin/sh
set -eu

database_path="${RADAR_DB_PATH:-/data/menglin-opportunity-radar.sqlite}"
collectors_root="${RADAR_COLLECTORS_ROOT:-/app/collectors}"
database_dir=$(dirname "$database_path")
mkdir -p "$database_dir"

if [ "${RADAR_IMPORT_ON_START:-1}" = "1" ] && [ ! -s "$database_path" ]; then
  echo "首次启动：正在把四城市公开快照导入持久化数据库。"
  node /app/scripts/import-city-collectors.mjs --from "$collectors_root" --database "$database_path"
fi

exec "$@"
