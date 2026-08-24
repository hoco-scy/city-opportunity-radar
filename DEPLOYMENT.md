# 自托管部署

这个仓库已从静态跳转页升级为 Node 服务：网页通过本服务的 API 读取 SQLite 数据库，四座城市共用同一个库。

## Docker 部署（推荐）

服务器上先把五个仓库放在同一目录，目录名保持不变：

```text
/srv/radars/
├── city-opportunity-radar-public/
├── beijing-opportunity-radar-public/
├── shanghai-opportunity-radar-public/
├── guangzhou-opportunity-radar-public/
└── shenzhen-opportunity-radar-public/
```

进入统一仓库，创建仅保存在服务器上的环境文件并启动：

```bash
cd /srv/radars/city-opportunity-radar-public
cp .env.example .env
# 编辑 .env，务必替换 RADAR_ADMIN_PASSWORD
mkdir -p backups
sudo chown 1000:1000 backups
chmod 700 backups
docker compose up -d --build
```

镜像构建时会把四城市采集器及其固定依赖一并装入，因此容器中的“立即全量更新”和每日更新计划不是静态演示。第一次启动且持久化数据库不存在时，入口脚本会自动导入镜像内的四城市快照；之后岗位、收藏、管理员账号、更新计划和事实日志都保存在 `radar-data` 卷中。重新构建镜像不会删除数据库。

默认只把服务映射到服务器的 `127.0.0.1:3000`。启动后可检查：

```bash
curl http://127.0.0.1:3000/api/health
docker compose ps
docker compose logs -f radar
```

升级代码时更新五个仓库，再执行 `docker compose up -d --build`。不要使用 `docker compose down -v`，其中 `-v` 会删除收藏与更新计划所在的数据卷。部署只应保持一个 `radar` 实例；SQLite 更新锁不适合跨多台服务器共享。

## 不使用 Docker 时第一次运行

需要 Node.js 22.13 或更高版本。当前机器的四个旧城市站仍位于同一个 `Code` 目录时，在本仓库运行：

```bash
npm run db:import:legacy
RADAR_ADMIN_USERNAME=menglin-admin RADAR_ADMIN_PASSWORD='请设置管理员密码' npm start
```

导入命令会读取四个城市站已经通过公开门禁的数据快照，写入本仓库被忽略的 `.data/menglin-opportunity-radar.sqlite`。数据库文件不能提交到公开仓库；它需要和服务一起保存在持久磁盘或挂载卷中。

如果旧城市站放在别处，可以显式指定它们共同的父目录：

```bash
npm run db:import:legacy -- --from /path/to/city-radars
```

管理员账号只会在空数据库第一次启动时由 `RADAR_ADMIN_USERNAME` 和 `RADAR_ADMIN_PASSWORD` 初始化。数据库只保存经 `scrypt` 派生的密码摘要；初始化成功后，即使继续保留这两个环境变量也不会重置密码。不要把密码写进仓库、日志或公开部署配置。迁移现有 SQLite 数据库到新服务器时，管理员账号会一同保留。密码至少 6 位；若网站经公网访问，应使用至少 16 位的随机强密码。

## 统一采集与更新

`npm run sync:all-cities` 是唯一的全量更新入口。它会按北京、上海、广州、深圳的顺序执行每个城市自己的全量工作流：

- 对该城市登记的公考、选调优培、聚合平台、重点单位与公告来源分别运行已经定义的采集方式；
- 运行来源计划、筛选政策、审核日志、公开数据和匿名发布门禁；
- 把通过城市工作流的官方岗位和可信来源采集结果统一导入 SQLite，并在页面上保留证据状态；
- 某个来源或城市失败时，继续执行其他城市，并将该失败保留为真实的部分完成状态，绝不等同于“没有岗位”。

登录首页的“管理员”后，也可以点击“立即全量更新”触发相同流程。控制台会实时追加事实日志，包括城市工作流启动、每个来源的实际状态与采集／筛选数量、五项门禁结果以及最终导入数量。日志、运行摘要和错误均保存在 SQLite 中；关闭页面不会中断更新，重新打开管理员控制台会续读最近一轮。部署机器上四个城市仓库需要位于同一个父目录；默认是统一仓库的上一级目录。若路径不同，在服务环境中设置 `RADAR_LEGACY_ROOT=/path/to/city-radars`。

管理员还可以在网页中启用自动更新，并填写每天 1–8 个北京时间，例如 `09:00, 14:00`。计划保存在与岗位数据相同的 SQLite 中；Node 服务启动时会自动恢复计时器，触发时调用同一个四城全量更新入口。

网页手动触发、内置定时器和 `npm run sync:all-cities` 共用 SQLite 中的进程级更新锁。若已有任务运行，新的触发会返回现有 `runId` 并接入同一份日志，不会创建第二条采集链路。运行中每 30 秒续写心跳；服务异常退出且心跳超过 5 分钟后，下一次触发会把旧运行标为失败并安全接管。多实例部署时，所有实例必须指向同一份支持文件锁的 SQLite 数据文件，否则无法形成全局互斥。

内置计时器依赖 Node 服务持续在线。也可以在部署平台使用 cron 作为额外兜底，但不要让两个调度器在同一分钟重复触发。

无论使用内置计划还是外部任务，都必须使用与网页服务相同的 `RADAR_DB_PATH`（若未设置即仓库内 `.data/menglin-opportunity-radar.sqlite`），以便更新立即反映在网站上。

## 数据备份、上传与恢复

系统提供两种迁移文件：

- 完整数据库备份是 SQLite 文件，包含岗位、来源、收藏、管理员账号摘要、更新计划与事实日志，用于整站搬迁；文件权限默认设为仅当前用户可读写。
- 公开数据包是 JSON 文件，只包含城市、岗位、公告、来源和公开更新记录，不包含收藏、管理员、会话、定时计划或后台运行日志，适合在不同环境间同步公开数据。

容器运行时，`./backups` 会映射到容器内的 `/backups`。完整备份可以在网站运行期间生成，底层使用 SQLite 在线备份接口读取同一个一致性快照：

```bash
docker compose exec radar npm run db:export
```

输出文件会出现在宿主机的 `backups/`。将它上传到服务器相同目录后，按以下顺序恢复：

```bash
docker compose stop radar
docker compose run --rm -e RADAR_IMPORT_ON_START=0 radar \
  npm run db:restore -- --input /backups/menglin-radar-full-时间.sqlite --confirm-stopped
docker compose up -d radar
```

恢复命令会先做 SQLite 完整性和必要数据表检查，并在显式确认服务已停止后把可能残留的 WAL 安全 checkpoint 回主文件；数据库仍繁忙时会拒绝操作。替换前还会在 `backups/` 自动生成 `before-restore` 完整备份，因此可以回滚。不要跳过 `docker compose stop radar`，也不要在多个服务实例仍连接数据库时恢复。

只迁移公开数据时使用：

```bash
docker compose exec radar npm run data:export

docker compose stop radar
docker compose run --rm -e RADAR_IMPORT_ON_START=0 radar \
  npm run data:import -- --input /backups/menglin-radar-public-时间.json --confirm-stopped
docker compose up -d radar
```

公开数据导入只替换公开表；服务器上已有的管理员账号、收藏、更新时间计划与后台运行日志会保留。收藏对应的岗位 ID 仍存在时，收藏关系也会保留。

不使用 Docker 时，四条命令的默认目录是仓库内 `backups/`，也可使用 `--output`、`--input`、`--database` 和 `--backup-dir` 指定路径。完整恢复同样要求先停止 `npm start`，并显式传入 `--confirm-stopped`。

## 岗位证据状态

岗位页统一展示两种证据层级：“官方信息已核验”表示采集流程已经定位到官方具体岗位；“可信来源收录”表示来自已登记且可追溯的公开平台。两者都保留原文入口，报名或投递前仍应核对专业、学历、届别、地点和截止时间。管理员不再拥有逐条放行或驳回岗位的权限。

## Tailscale

服务默认只监听 `127.0.0.1:3000`，适合让 Tailscale 接管 HTTPS。确认本机服务正在运行后，可将它交给 Tailscale Serve：

```bash
tailscale serve --https=443 http://127.0.0.1:3000
```

如果你已经为该设备启用了公网 Funnel，沿用现有 Funnel 配置即可；不要把 SQLite 文件暴露为静态目录，也不要把服务改为直接监听公网地址。

## 收藏与隐私

收藏要求用户手动输入自己的标识符，网页不会自动生成。新标识符需为 6–64 位英文、数字、下划线或连字符，并以英文或数字开头；建议使用至少 12 位、难以被猜到且不包含姓名等个人信息的组合。数据库只存标识符的 SHA-256 摘要、岗位 ID 和创建时间；不保存姓名、邮箱、学校、联系方式或私有资格档案。旧版已经使用的 `mlr_...` 收藏代码仍可继续输入，以免已有收藏丢失。

用户标识符具有轻量登录凭证的效果：知道它的人可以查看和修改对应收藏。请只在受信任的设备或密码管理器中保存。后续引入正式登录时，可以把该标识符作为一次性迁移凭证。

## 数据保管

`.data/menglin-opportunity-radar.sqlite` 同时保存公开岗位、用户标识符摘要、管理员密码摘要和自动更新计划。它不能提交到公开仓库，也不能作为静态文件对外暴露；部署时请把 `.data` 放在持久磁盘或挂载卷，并定期做受控备份。
