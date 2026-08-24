# 公考公告与职位表采集器

这个采集器只读取官方公开页面、接口和附件，输出一份采集清单；它**不会**改写 `data/opportunities.json`、`data/review-log.json`、网页或 Git 历史。采集与“判断某个具体岗位是否可报”是两个独立阶段：后者仍必须对完整职位表逐项执行资格门禁。

## 云端运行

在新的 Codex 容器中运行：

```sh
npm ci --ignore-scripts
node scripts/collect-public-exams.mjs --source national-civil --summary
node scripts/collect-public-exams.mjs --source beijing-civil --parse-position-tables --summary
node scripts/collect-public-exams.mjs --source shanghai-civil --summary
node scripts/collect-public-exams.mjs --source guangzhou-civil --parse-position-tables --summary
node scripts/collect-public-exams.mjs --source shenzhen-civil --parse-position-tables --summary
```

它需要对相应官方域名的 HTTP/HTTPS 访问权限，但不需要浏览器 Cookie、登录、验证码、个人资料或已有本地缓存。`--snapshot /private/tmp/<source>.json` 是显式选择的本地增量快照：本轮会输出 `new`、`changed`、`unchanged`，并只写入这个指定路径。

## 四条官方路线

| 来源 | 脚本路线 | 职位表处理 |
| --- | --- | --- |
| 国考 | 国家公务员局主入口和补充录用入口 → 前端配置中的当期专题 ID → 官方 JSON → 公告详情/附件 | 若公告提供公开附件则解析；若当期公开职位查询页面改版，记录 `accessible-incomplete` 并只用浏览器重新校准一次公开请求，不能猜测接口或绕过登录。 |
| 京考 | `beijing.gov.cn` 公告列表与分页 → 公告详情 → 官方附件 | 直链 XLS/XLSX 由本地解析器读取。 |
| 上海市考 | `shacs.gov.cn` 专题 JSON → 专题公告 JSON → 公告详情 JSON | 当前专题公告多数把职位查询放在当期考试系统；公告监测完全脚本化。公开附件出现时自动解析；系统关闭或登录后才可见的职位不能伪称已采集。 |
| 广东省考（广州/深圳） | 广东组织工作网公告列表与分页 → 公告详情 → 官方 ZIP/Excel；主列表不可用时回退省公务员考试系统公告页 | 解开 ZIP 后定位含职位表头的 XLS/XLSX/CSV，再按“广州市”或“深圳市”筛行。 |

采集器只允许登记域名；国考 HTTP 路径是来源登记的官方兼容入口，其他来源只能使用 HTTPS。每个附件限制为 30MB，每个工作簿限制为 20MB；解析器只保留出现招录机关、职位、代码等可识别职位表头的工作表。

## 结果与后续门禁

成功采集不表示“有可报岗位”。输出中的职位行只用于下一步结构化筛选；必须逐项核对学历、学位、应届身份、专业、政治面貌、户籍/生源地、基层经历、年龄和备注等条件。任何文件下载、表头识别、分页或公告详情失败都只会把采集结果标为 `completed-partial`，绝不写成“无岗位”。

浏览器的职责仅剩两件事：首次确认一个新公开接口，或在官方改版后重新校准脚本。它不再是每次定时任务的默认采集方式。
