# 广州求职雷达

匿名公开的岗位级信息看板，重点关注粤考、国考、广州定向选调与优培、广州事业单位，以及工作地点在广州的央国企岗位。

## 工作方式

- 高召回发现：覆盖生物医学工程、工学、理工类、交叉专业与不限专业，不以医学关键词提前截断结果。
- 官网筛选优先：充分利用每个招聘站自己的届别、地点、学历、类别和关键词控件，多组结果取并集后再由模型批量复核。
- 官方逐岗核验：公考遍历完整职位表；央国企遍历官方招聘系统全部分页和职位板块。
- 预公告追踪：官方已发布且截止未过即纳入；有职位表时生成“即将开放”岗位，无职位表时写入审核日志持续追踪。
- 失败可见：关键官网最多尝试三次，仍失败则显示“部分完成”，绝不把访问失败当作没有公告。
- 客观质量筛选：只有官方可核验的明显低待遇、高强度、高危、有害暴露、长期夜班倒班或重体力等事实才会硬排除；未知信息保留待确认，不使用性别刻板印象。
- 匿名门禁：公考使用私有资格档案逐项判断，但公开仓库不保存或显示任何私人值。

网站分成四个独立页面：`index.html` 查看具体岗位并筛选当前浏览器收藏，`monitors.html` 跟踪考试公告，`sources.html` 查看正在检查的信息源及其覆盖范围，`audit.html` 查看每轮匿名发现、核验、通过、未通过和继续跟踪记录。旧的 `favorites.html` 仅保留为兼容跳转。

岗位数据位于 `data/opportunities.json`，审核记录位于 `data/review-log.json`，来源池和运行策略位于 `data/source-registry.json`、`data/source-plan.json`、`data/screening-policy.json` 与 `data/filter-recipes.json`。正文只展示通过门禁的具体岗位。

提交前运行：

```bash
node scripts/validate-source-plan.mjs
node scripts/validate-screening-policy.mjs
node scripts/validate-data.mjs
node scripts/validate-review-log.mjs
node scripts/check-privacy.mjs
node --test tests/site-structure.test.mjs
```

GitHub Pages 只有在全部门禁通过后才会部署。

## 云端同步文档

[`AUTOMATION.md`](AUTOMATION.md) 是每次同步都要重新读取的运行手册，定义来源检查、核验、写入和发布的完成条件。运行时间、通知和云端任务提示词与它分离，统一维护在 [`automation/task-prompts.md`](automation/task-prompts.md)；其中不保存任何私有档案字段。
