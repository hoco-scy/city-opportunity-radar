# 梦琳求职雷达

北京、上海、广州、深圳的统一求职雷达服务。岗位、信息源、更新记录均由 SQLite 保存并通过 API 提供给同一个网页；公开页面不保存候选人的个人资料。

主要入口：

- `npm run db:import:legacy`：把四个既有城市站的公开快照迁入统一数据库。
- `npm start`：启动本地服务。
- `npm test`：导入四座城市并验证 API、跨设备收藏和网页资源。

部署与隐私说明见 [DEPLOYMENT.md](DEPLOYMENT.md)。
