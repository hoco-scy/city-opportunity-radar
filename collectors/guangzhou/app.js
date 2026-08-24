const state = {
  activeTrack: "全部",
  activeMatch: "全部",
  query: "",
  savedOnly: new URLSearchParams(location.search).get("saved") === "1",
  data: null,
};

const tasks = [
  "先看快截止和招满即止的广州岗位",
  "把“相关专业”说不清的岗位单独列出来确认",
  "公考职位表发布后，再按专业代码完整筛一遍",
];

const readList = (key) => {
  try { return JSON.parse(localStorage.getItem(key) || "[]"); }
  catch { return []; }
};

let saved = readList("radar-saved-opportunities");
let doneTasks = readList("radar-done-tasks");

const get = (selector) => document.querySelector(selector);
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

const formatDate = (value) => value ? value.replaceAll("-", ".") : "未注明";
const formatDateTime = (value) => value ? new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
}).format(new Date(value)).replaceAll("/", ".") : "未记录";

function searchText(job) {
  return [job.title, job.exactTitle, job.organization, job.department, job.location,
    job.jobCode, job.education, job.majors, job.matchReason, ...job.tags,
    ...job.responsibilities, ...job.requirements].join(" ").toLowerCase();
}

function filteredJobs() {
  const keyword = state.query.trim().toLowerCase();
  return state.data.jobs.filter((job) =>
    (!state.savedOnly || saved.includes(job.id)) &&
    (state.activeTrack === "全部" || job.track === state.activeTrack) &&
    (state.activeMatch === "全部" || job.matchLevel === state.activeMatch) &&
    (!keyword || searchText(job).includes(keyword))
  ).sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.title.localeCompare(b.title, "zh-CN"));
}

function renderCards() {
  const list = get("#opportunity-list");
  if (!list) return;
  const jobs = filteredJobs();
  const resultCount = get("#result-count");
  if (resultCount) resultCount.textContent = state.savedOnly ? `${jobs.length} 个收藏` : `${jobs.length} 个岗位`;

  if (!jobs.length) {
    let title = "没有符合当前筛选的岗位";
    let message = "换一个方向或关键词试试。";
    if (state.savedOnly) {
      title = "还没有收藏岗位";
      message = "回到岗位页，点击岗位右上角的心形即可收藏。";
    } else if (state.activeTrack === "考公") {
      message = "公考岗位只有在所有报考条件都确认后才会显示。";
    }
    list.innerHTML = `<div class="empty-state"><strong>${title}</strong><p>${message}</p></div>`;
    return;
  }

  list.innerHTML = jobs.map((job) => {
    const isSaved = saved.includes(job.id);
    const verified = job.verifiedFields.map((field) => `<span>✓ ${escapeHTML(field)}</span>`).join("");
    const risks = job.riskNotes.length
      ? `<div class="risk-note"><strong>投递前再确认</strong><ul>${job.riskNotes.map((note) => `<li>${escapeHTML(note)}</li>`).join("")}</ul></div>`
      : "";
    const sourceLabel = job.track === "考公" ? "报考条件已核对" : "信息来自招聘官网";

    return `<article class="opportunity-card">
      <div class="card-accent" data-track="${escapeHTML(job.track)}"></div>
      <div class="card-content">
        <div class="card-topline">
          <span class="track-tag track-${escapeHTML(job.track)}">${escapeHTML(job.track)}</span>
          <span class="official-tag">● ${sourceLabel}</span>
          <span class="freshness-tag">${escapeHTML(job.status)}</span>
          <button class="save-button ${isSaved ? "saved" : ""}" data-save="${escapeHTML(job.id)}" type="button" aria-pressed="${isSaved}" aria-label="${isSaved ? "取消收藏" : "收藏"} ${escapeHTML(job.title)}">${isSaved ? "♥" : "♡"}</button>
        </div>
        <div class="card-title-row">
          <div><h3>${escapeHTML(job.title)}</h3><p>${escapeHTML(job.organization)} · ${escapeHTML(job.department)}</p></div>
          <div class="match-score"><strong>${escapeHTML(job.priority)}</strong><span>${escapeHTML(job.matchLevel)}</span></div>
        </div>
        <div class="job-facts">
          <div><span>职位代码</span><strong>${escapeHTML(job.jobCode)}</strong></div>
          <div><span>工作地点</span><strong>${escapeHTML(job.location)}</strong></div>
          <div><span>招聘对象</span><strong>${escapeHTML(job.cohort)}</strong></div>
          <div><span>学历要求</span><strong>${escapeHTML(job.education)}</strong></div>
          <div><span>招聘人数</span><strong>${escapeHTML(job.headcount)}</strong></div>
          <div><span>发布时间</span><strong>${formatDate(job.publishedAt)}</strong></div>
        </div>
        <p class="match-reason"><strong>为什么值得看</strong>${escapeHTML(job.matchReason)}</p>
        <div class="requirement-strip"><span>专业要求</span><p>${escapeHTML(job.majors)}</p></div>
        <div class="tag-row">${job.tags.map((tag) => `<span>${escapeHTML(tag)}</span>`).join("")}</div>
        <details class="job-details">
          <summary>岗位职责和完整要求 <span>＋</span></summary>
          <div class="details-grid">
            <section><h4>主要工作</h4><ul>${job.responsibilities.map((item) => `<li>${escapeHTML(item)}</li>`).join("")}</ul></section>
            <section><h4>招聘要求</h4><ul>${job.requirements.map((item) => `<li>${escapeHTML(item)}</li>`).join("")}</ul></section>
          </div>
          ${risks}
          <div class="verification-row"><strong>已经核对</strong>${verified}</div>
        </details>
        <div class="card-footer">
          <div class="deadline-block"><span>报名截止</span><strong>${escapeHTML(job.deadline)}</strong></div>
          <div class="source-actions"><a href="${safeUrl(job.officialAnnouncementUrl)}" target="_blank" rel="noreferrer">查看招聘说明 ↗</a><a class="apply-link" href="${safeUrl(job.officialApplyUrl)}" target="_blank" rel="noreferrer">去官网找 ${escapeHTML(job.jobCode)} ↗</a></div>
        </div>
        <p class="source-note">${escapeHTML(job.applyInstruction)}<br />信息更新于 ${formatDateTime(job.lastSeenAt)}，报名和投递前请以官网为准。</p>
      </div>
    </article>`;
  }).join("");

  document.querySelectorAll("[data-save]").forEach((button) => button.addEventListener("click", () => {
    const id = button.dataset.save;
    saved = saved.includes(id) ? saved.filter((item) => item !== id) : [...saved, id];
    localStorage.setItem("radar-saved-opportunities", JSON.stringify(saved));
    updateCounts();
    renderCards();
  }));
}

function renderMonitors() {
  const grid = get("#monitor-grid");
  if (!grid) return;
  if (!state.data.monitors.length) {
    grid.innerHTML = `<div class="empty-state"><strong>等待首次完整更新</strong><p>公告和职位表会在完成官网核验后显示。</p></div>`;
    return;
  }
  grid.innerHTML = state.data.monitors.map((monitor) => {
    const alternate = monitor.alternateOfficialUrl
      ? `<a href="${safeUrl(monitor.alternateOfficialUrl)}" target="_blank" rel="noreferrer">${escapeHTML(monitor.alternateOfficialLabel || "相关信息")} ↗</a>`
      : "";
    return `<article class="monitor-card">
      <div><span class="monitor-track">${escapeHTML(monitor.track)}</span><span class="monitor-status">${escapeHTML(monitor.status)}</span></div>
      <h3>${escapeHTML(monitor.title)}</h3><p>${escapeHTML(monitor.note)}</p>
      <footer><span>最近更新 ${formatDateTime(monitor.checkedAt)}</span><span class="monitor-actions"><a href="${safeUrl(monitor.officialUrl)}" target="_blank" rel="noreferrer">查看官网 ↗</a>${alternate}</span></footer>
    </article>`;
  }).join("");
}

function renderTasks() {
  const list = get("#task-list");
  if (!list) return;
  list.innerHTML = tasks.map((task, index) => `<label class="task ${doneTasks.includes(index) ? "done" : ""}"><input type="checkbox" data-task="${index}" ${doneTasks.includes(index) ? "checked" : ""}/><span class="fake-check">✓</span><span>${escapeHTML(task)}</span></label>`).join("");
  document.querySelectorAll("[data-task]").forEach((box) => box.addEventListener("change", () => {
    const index = Number(box.dataset.task);
    doneTasks = doneTasks.includes(index) ? doneTasks.filter((item) => item !== index) : [...doneTasks, index];
    localStorage.setItem("radar-done-tasks", JSON.stringify(doneTasks));
    renderTasks();
    updateCounts();
  }));
}

function updateCounts() {
  const savedCount = get("#saved-count");
  const filterCount = get("#saved-filter-count");
  const taskCount = get("#task-count");
  if (savedCount) savedCount.textContent = saved.length;
  if (filterCount) filterCount.textContent = saved.length;
  if (taskCount) taskCount.textContent = `${doneTasks.length}/${tasks.length}`;
}

function updateSummary() {
  const jobs = state.data.jobs;
  const meta = state.data.meta;
  const syncDate = get("#sync-date");
  if (syncDate) syncDate.innerHTML = meta.initializationStatus === "awaiting-first-sync"
    ? `<i></i>等待首次完整更新`
    : `<i></i>最近更新：${formatDateTime(meta.lastVerifiedAt)}`;
  if (get("#stat-jobs")) get("#stat-jobs").textContent = jobs.length;
  if (get("#stat-guangzhou")) get("#stat-guangzhou").textContent = jobs.filter((job) => job.location.includes("广州")).length;
  if (get("#stat-tracks")) get("#stat-tracks").textContent = new Set(jobs.map((job) => job.track)).size;
  if (get("#hero-job-count")) get("#hero-job-count").textContent = jobs.length;
}

function bindFilters() {
  document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => {
    state.activeTrack = button.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach((item) => item.classList.toggle("active", item === button));
    renderCards();
  }));
  document.querySelectorAll("[data-match]").forEach((button) => button.addEventListener("click", () => {
    state.activeMatch = button.dataset.match;
    document.querySelectorAll("[data-match]").forEach((item) => item.classList.toggle("active", item === button));
    renderCards();
  }));
  const search = get("#search");
  if (search) search.addEventListener("input", (event) => { state.query = event.target.value; renderCards(); });
  const savedFilter = get("[data-saved-filter]");
  if (savedFilter) {
    savedFilter.classList.toggle("active", state.savedOnly);
    savedFilter.setAttribute("aria-pressed", String(state.savedOnly));
    savedFilter.firstChild.textContent = state.savedOnly ? "♥ 我的收藏 " : "♡ 我的收藏 ";
    savedFilter.addEventListener("click", () => {
      state.savedOnly = !state.savedOnly;
      savedFilter.classList.toggle("active", state.savedOnly);
      savedFilter.setAttribute("aria-pressed", String(state.savedOnly));
      savedFilter.firstChild.textContent = state.savedOnly ? "♥ 我的收藏 " : "♡ 我的收藏 ";
      renderCards();
    });
  }
}

async function init() {
  try {
    const response = await fetch("data/opportunities.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    updateSummary();
    updateCounts();
    bindFilters();
    renderCards();
    renderMonitors();
    renderTasks();
  } catch (error) {
    const jobs = get("#opportunity-list");
    const monitors = get("#monitor-grid");
    if (jobs) jobs.innerHTML = `<div class="empty-state"><strong>岗位暂时没有加载出来</strong><p>请稍后刷新页面。</p></div>`;
    if (monitors) monitors.innerHTML = `<div class="empty-state"><strong>公告暂时没有加载出来</strong><p>请稍后刷新页面。</p></div>`;
    console.error("Failed to load opportunities", error);
  }
}

init();
