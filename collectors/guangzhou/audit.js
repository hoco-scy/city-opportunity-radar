const auditState = { decision: "all", data: null };

const escapeHTML = (value = "") => String(value)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

const httpOnlyOfficialHosts = new Set([
  "bm.scs.gov.cn", "subb.scs.gov.cn", "job.mohrss.gov.cn",
  "wap.sasac.gov.cn", "www.spacetalent.com.cn"
]);
const safeUrl = (value = "") => {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return url.href;
    if (url.protocol === "http:" && httpOnlyOfficialHosts.has(url.hostname)) return url.href;
    return "#";
  } catch { return "#"; }
};

const formatDateTime = (value) => value ? new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
}).format(new Date(value)).replaceAll("/", ".") : "未记录";

const decisionLabels = { accepted: "已收录", rejected: "不符合", deferred: "还要确认" };
const runStatusLabels = { completed: "本次更新", "completed-partial": "部分信息待确认", failed: "暂无更新", "not-started": "等待首次更新" };
const scopeLabels = { announcement: "整份公告", position: "具体岗位", "official-system": "招聘官网" };
const sourceLabels = {
  "national-civil": "国家公务员局",
  "guangzhou-civil": "广州市公务员招考",
  "guangzhou-selection-program": "广州选调／优培公告",
  "guangzhou-personnel-exam": "广州市人事考试平台",
  "guangzhou-institutions": "广州市事业单位招聘",
  "central-institutions": "中央和国家机关事业单位招聘",
  "china-public-recruitment": "中国公共招聘网",
  "central-sasac-recruitment": "国务院国资委招聘",
  "central-enterprise-roster": "中央企业名录",
  "guangzhou-state-assets": "广州市国资委招聘",
  "picc-campus": "中国人保校园招聘",
  "boe-campus": "京东方校园招聘",
  "cmcc-careers": "中国移动招聘",
  "chinatelecom-careers": "中国电信招聘",
  "sinopec-careers": "中国石化招聘",
  "casic-careers": "中国航天科工招聘",
  "spacechina-careers": "中国航天科技招聘",
  "chinapost-recruitment": "中国邮政招聘",
};
const sourceStatusLabels = {
  "checked-deferred": "具体岗位尚待公布",
  "checked-full-pagination": "已核对相关岗位",
  "checked-native-filtered": "已关注最新招聘信息",
  "checked-no-active-campaign": "当前没有有效招聘活动",
  "checked-no-new-position-table": "暂无新的职位表",
  "checked-no-publishable-change": "暂无可加入岗位页的新岗位",
  "checked-roster-current": "暂无影响岗位清单的新信息",
  "accessible-incomplete": "具体岗位信息待确认",
  "temporarily-unavailable": "暂未取得可确认的最新信息",
  "semantic-404": "暂未取得可确认的最新信息",
  "failed": "暂未取得可确认的最新信息",
};

function filteredReviews(run) {
  if (auditState.decision === "all") return run.reviews;
  return run.reviews.filter((review) => review.decision === auditState.decision);
}

function publicReviewTitle(title = "") {
  return title
    .replace(/\s*本轮(?:复查|跟踪)$/, "")
    .replace(/全单位岗位跟踪$/, "")
    .replace(/全量岗位批量复核待办$/, "招聘信息")
    .replace(/公告复查$/, "公告");
}

function publicField(value = "") {
  return /本轮|入口|全量|筛选|遍历|延后|未能完整|未提供可稳定核验|官方系统|系统列出/.test(value) ? "官方未注明" : value;
}

function publicReviewReason(review) {
  const reasons = {
    "enterprise-position-verified": "已在招聘单位官网找到具体岗位，可打开官网查看完整要求和投递方式。",
    "role-domain-not-aligned": "结合岗位职责、专业条件和服务业务复核后，未发现与生物医学工程背景相符的明确交叉，因此没有加入岗位页。",
    "broad-eligibility-needs-confirmation": "官网未限定为不相关专业，岗位信息完整；生物医学工程是否符合具体认定，建议投递前确认。",
    "open-major-product-role-needs-confirmation": "官网允许其他专业申请产品岗位；是否认可生物医学工程背景，建议投递前确认。",
    "open-major-solution-role-needs-confirmation": "官网未限制专业，岗位偏方案与项目协同；是否认可生物医学工程背景，建议投递前确认。",
    "signal-analysis-cross-domain-needs-confirmation": "岗位涉及信号分析，与生物医学工程的能力存在交叉；专业认定和具体业务适配仍建议确认。",
    "objective-role-risk": "官网岗位说明出现高风险或高强度工作要求，因此没有加入岗位页。",
    "candidate-category-mismatch": "招聘对象与公告要求不一致，因此没有放入岗位页。",
    "full-pagination-incomplete": "目前还不能形成可单独确认的具体岗位，暂时不放入岗位页。",
    "position-fields-incomplete": "关键岗位信息尚未公布完整，暂时不放入岗位页。",
    "structured-batch-review-pending": "公开信息仍待补充确认，暂时不放入岗位页。",
  };
  return reasons[review.reasonCode] || "当前公开信息不足以形成可确认的具体岗位。";
}

function renderReview(review) {
  return `<article class="review-card decision-${escapeHTML(review.decision)}">
    <div class="review-card-topline">
      <span class="decision-badge">${escapeHTML(decisionLabels[review.decision] || review.decision)}</span>
      <span>${escapeHTML(review.track)} · ${escapeHTML(scopeLabels[review.scope] || "招聘信息")}</span>
    </div>
    <h4>${escapeHTML(publicReviewTitle(review.title))}</h4>
    <p class="review-org">${escapeHTML(review.organization)}</p>
    <div class="review-facts"><span>${escapeHTML(publicField(review.headcount))}</span><span>截止：${escapeHTML(publicField(review.deadline))}</span><span>发布：${escapeHTML(review.officialPublishedAt)}</span></div>
    <div class="review-reason"><strong>处理结果</strong><p>${escapeHTML(publicReviewReason(review))}</p></div>
    <div class="review-fallback"><a href="${safeUrl(review.officialUrl)}" target="_blank" rel="noreferrer">查看官网 ↗</a></div>
  </article>`;
}

function publicRunSummary(run) {
  const changed = run.metrics.published + run.metrics.updated + run.metrics.closed;
  return changed
    ? "岗位页已经同步本次新增或变化的具体岗位；其他公告会在岗位信息明确后继续补充。"
    : "本次没有新增的具体岗位；已发布的公告会继续在公告页显示。";
}

function renderRun(run) {
  const reviews = filteredReviews(run);
  const metrics = run.metrics;
  const changed = metrics.published + metrics.updated + metrics.closed;
  let outcome = changed ? `岗位页有 ${changed} 项变化` : "岗位页没有变化";
  if (run.status === "completed-partial") outcome = `${outcome} · 部分信息仍待确认`;
  if (run.status === "failed") outcome = "本次暂无岗位更新";

  const sourceChecks = run.sourceChecks.map((source) => {
    const statusLabel = sourceStatusLabels[source.status] || "持续关注";
    return `<li><strong>${escapeHTML(sourceLabels[source.sourceId] || source.sourceId)}</strong><span><b>${escapeHTML(statusLabel)}</b></span></li>`;
  }).join("");
  const reviewContent = reviews.length
    ? reviews.map(renderReview).join("")
    : `<div class="empty-state compact"><strong>这次没有这一类记录</strong><p>可以切换上面的筛选查看其他结果。</p></div>`;

  return `<article class="audit-run">
    <header class="run-header">
      <div><span class="run-time">${formatDateTime(run.checkedAt)}</span><h3>${escapeHTML(outcome)}</h3><p>${publicRunSummary(run)}</p></div>
      <span class="run-status ${escapeHTML(run.status)}">${escapeHTML(runStatusLabels[run.status] || run.status)}</span>
    </header>
    <div class="run-metrics">
      <div><strong>${metrics.published}</strong><span>新增岗位</span></div>
      <div><strong>${metrics.updated}</strong><span>更新岗位</span></div>
      <div><strong>${metrics.accepted}</strong><span>可查看</span></div>
      <div><strong>${metrics.rejected}</strong><span>不符合</span></div>
      <div><strong>${metrics.deferred}</strong><span>待确认</span></div>
      <div><strong>${metrics.closed}</strong><span>已结束</span></div>
    </div>
    <details class="source-checks"><summary>关注的信息源 <span>＋</span></summary><ul>${sourceChecks}</ul></details>
    <div class="review-grid">${reviewContent}</div>
  </article>`;
}

function render() {
  if (!auditState.data.runs.length) {
    document.querySelector("#sync-date").innerHTML = `<i></i>等待首次完整更新`;
    document.querySelector("#latest-run").textContent = "尚未开始";
    document.querySelector("#latest-reviewed").textContent = "—";
    document.querySelector("#latest-published").textContent = "—";
    document.querySelector("#audit-run-list").innerHTML = `<div class="empty-state"><strong>等待首次完整更新</strong><p>完成官网核验后，这里会留下每次处理和审核的记录。</p></div>`;
    return;
  }
  const latest = auditState.data.runs[0];
  document.querySelector("#sync-date").innerHTML = `<i></i>最近更新：${formatDateTime(auditState.data.meta.lastRunAt)}`;
  document.querySelector("#latest-run").textContent = formatDateTime(latest.checkedAt);
  document.querySelector("#latest-reviewed").textContent = `${latest.metrics.reviewedItems} 项`;
  document.querySelector("#latest-published").textContent = `${latest.metrics.published} 项`;
  document.querySelector("#audit-run-list").innerHTML = auditState.data.runs.map(renderRun).join("");
}

function bindFilters() {
  document.querySelectorAll("[data-decision]").forEach((button) => button.addEventListener("click", () => {
    auditState.decision = button.dataset.decision;
    document.querySelectorAll("[data-decision]").forEach((item) => item.classList.toggle("active", item === button));
    render();
  }));
}

async function init() {
  try {
    const response = await fetch("data/review-log.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    auditState.data = await response.json();
    bindFilters();
    render();
  } catch (error) {
    document.querySelector("#audit-run-list").innerHTML = `<div class="empty-state"><strong>更新记录暂时没有加载出来</strong><p>请稍后刷新页面。</p></div>`;
    console.error("Failed to load review log", error);
  }
}

init();
