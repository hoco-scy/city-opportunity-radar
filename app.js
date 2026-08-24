const page = document.body.dataset.page;
const initialQuery = new URLSearchParams(window.location.search);
const state = {
  cities: [],
  cityId: localStorage.getItem("menglin-radar-city") || "beijing",
  track: initialQuery.get("favorites") === "1" ? "我的收藏" : "全部",
  query: "",
  sourceView: "shortcut",
  favorites: new Set(),
  code: localStorage.getItem("menglin-radar-favorite-code") || "",
  adminSession: sessionStorage.getItem("menglin-radar-admin-session") || "",
  adminUsername: "",
};

const byId = (id) => document.getElementById(id);
const escapeHtml = (value = "") => String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
const dateLabel = (value) => value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" }).format(new Date(value)) : "暂无更新记录";
const favoriteKey = (cityId, opportunityId) => `${cityId}:${opportunityId}`;

function makeCode() {
  const raw = Array.from(crypto.getRandomValues(new Uint8Array(32)), (number) => number.toString(16).padStart(2, "0")).join("");
  return `mlr_${raw}`;
}

function ensureCode() {
  if (!state.code) {
    state.code = makeCode();
    localStorage.setItem("menglin-radar-favorite-code", state.code);
  }
  return state.code;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body) headers.set("content-type", "application/json");
  if (options.favorite) headers.set("x-radar-user-code", ensureCode());
  if (options.admin) {
    if (!state.adminSession) throw new Error("请先登录管理员账号");
    headers.set("x-radar-admin-session", state.adminSession);
  }
  const response = await fetch(path, { ...options, headers });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "请求失败");
  return result;
}

async function loadFavorites() {
  const { favorites } = await api("/api/favorites", { favorite: true });
  state.favorites = new Set(favorites.map((item) => favoriteKey(item.cityId, item.opportunityId)));
  const count = byId("favorite-count");
  if (count) count.textContent = state.favorites.size;
}

function renderCities() {
  byId("city-tabs").innerHTML = state.cities.map((city) => `
    <button class="city-tab ${city.id === state.cityId ? "active" : ""}" data-city="${city.id}" role="tab" aria-selected="${city.id === state.cityId}">
      <span>${escapeHtml(city.name)}</span><small>${city.opportunity_count} 条岗位信息</small>
    </button>
  `).join("");
  document.querySelectorAll("[data-city]").forEach((button) => button.addEventListener("click", () => selectCity(button.dataset.city)));
}

function updateLastChecked(city) {
  const lastUpdated = byId("last-updated");
  if (lastUpdated) lastUpdated.textContent = city.last_checked_at ? `最近核验：${dateLabel(city.last_checked_at)}` : "尚未导入更新记录";
}

function renderJobs(opportunities) {
  const list = byId("opportunity-list");
  const filtered = opportunities.filter((item) => {
    if (state.track === "我的收藏") return state.favorites.has(favoriteKey(state.cityId, item.id));
    return state.track === "全部" || displayTrack(item) === state.track;
  });
  const emptyTitle = state.track === "我的收藏" ? "还没有收藏岗位" : "没有符合当前条件的岗位信息";
  const emptyNote = state.track === "我的收藏" ? "点击岗位右上角的心形按钮，收藏会自动同步到这串收藏代码。" : "换一个赛道或关键词看看。";
  list.innerHTML = filtered.length ? filtered.map(opportunityCard).join("") : `<div class="empty-state"><strong>${emptyTitle}</strong><p>${emptyNote}</p></div>`;
  document.querySelectorAll("[data-save]").forEach((button) => button.addEventListener("click", () => toggleFavorite(button.dataset.save)));
}

function displayTrack(item) {
  if (["考公", "选调优培", "央国企", "事业单位"].includes(item.track)) return item.track;
  const text = `${item.recruitmentType || ""} ${(item.tags || []).join(" ")} ${item.organization || ""}`;
  if (/选调|优培/.test(text)) return "选调优培";
  if (/事业单位|研究所|研究院|医院|高校/.test(text)) return "事业单位";
  if (/公务员|国考|省考|市考/.test(text)) return "考公";
  return "央国企";
}

function opportunityCard(item) {
  const saved = state.favorites.has(favoriteKey(state.cityId, item.id));
  const track = displayTrack(item);
  const trustedSource = item.evidenceStatus === "trusted-source";
  const tags = (item.tags || []).filter((tag) => !/待确认|需手动确认|未核验/.test(tag)).slice(0, 6).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("");
  const sourceUrl = item.sourceUrl || item.officialAnnouncementUrl;
  const directUrl = item.officialApplyUrl && item.officialApplyUrl !== sourceUrl ? item.officialApplyUrl : null;
  const primaryUrl = trustedSource ? sourceUrl || item.officialApplyUrl : item.officialApplyUrl || item.officialAnnouncementUrl;
  const reason = trustedSource
    ? "来自已纳入工作流的可信公开来源，并已通过城市、学历与公开专业条件初筛；报名前请核对来源原文。"
    : item.matchReason || "已回到官方岗位页核验关键信息。";
  const status = trustedSource && item.status === "待用户确认" ? "来源已收录" : item.status || "以原文为准";
  const checkedPrefix = trustedSource ? "采集" : "核验";
  const primaryLabel = trustedSource ? "查看来源原页 ↗" : "查看官方岗位页 ↗";
  return `<article class="opportunity-card"><div class="card-accent" data-track="${escapeHtml(track)}"></div><div class="card-content"><div class="card-topline"><span class="track-tag track-${escapeHtml(track)}">${escapeHtml(track)}</span><span class="official-tag ${trustedSource ? "source-evidence-tag" : ""}">${escapeHtml(item.evidenceLabel || "官方信息已核验")}</span><button class="save-button ${saved ? "saved" : ""}" data-save="${escapeHtml(item.id)}" aria-label="${saved ? "取消收藏" : "收藏"} ${escapeHtml(item.exactTitle || item.title)}" type="button">${saved ? "♥" : "♡"}</button></div><div class="card-title-row"><div><h3>${escapeHtml(item.exactTitle || item.title)}</h3><p>${escapeHtml(item.organization)} · ${escapeHtml(item.location || "地点以原文为准")}</p></div><div class="match-score"><strong>${escapeHtml(item.priority ?? "—")}</strong><span>关注度</span></div></div><p class="match-reason">${escapeHtml(reason)}</p><div class="tag-row">${tags}</div><div class="card-footer"><div><span class="status-pill">${escapeHtml(status)}</span><span class="deadline">${escapeHtml(item.deadline || "截止时间以原文为准")}</span><span class="verified-date">${checkedPrefix} ${escapeHtml(item.verifiedAt || "")}</span></div><div>${primaryUrl ? `<a href="${escapeHtml(primaryUrl)}" target="_blank" rel="noreferrer">${primaryLabel}</a>` : ""}${directUrl && directUrl !== primaryUrl ? `<a href="${escapeHtml(directUrl)}" target="_blank" rel="noreferrer">投递链接 ↗</a>` : ""}</div></div></div></article>`;
}

function renderAnnouncements(announcements) {
  byId("announcement-list").innerHTML = announcements.length ? announcements.map((item) => {
    const officialUrl = item.officialUrl || item.officialAnnouncementUrl;
    return `<article class="announcement-card"><div><span class="track-tag track-${escapeHtml(item.track)}">${escapeHtml(item.track)}</span><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.note || "公告正在监测中；以官方发布时间为准。")}</p></div><div class="announcement-meta"><strong>${escapeHtml(item.status || "持续监测")}</strong>${item.checkedAt ? `<span>最近查看：${escapeHtml(dateLabel(item.checkedAt))}</span>` : ""}${officialUrl ? `<a href="${escapeHtml(officialUrl)}" target="_blank" rel="noreferrer">查看官方入口 ↗</a>` : ""}</div></article>`;
  }).join("") : "<div class=\"empty-state\"><strong>当前没有单独展示的公告</strong><p>后续公告会在这里更新，岗位表通过核验后会进入岗位页。</p></div>";
}

function sourceCard(item) {
  if (state.sourceView === "collection") {
    const latest = item.latestCheck
      ? `<p class="check-note">${item.latestCheck.isCurrent ? "最近已核验" : "最近一轮未覆盖"}：${escapeHtml(dateLabel(item.latestCheck.checkedAt))}</p>`
      : "<p class=\"check-note\">尚无公开核验记录</p>";
    const metrics = item.latestCheck?.collectionMetrics;
    const counts = !metrics
      ? "本轮未记录采集数量"
      : ["completed", "partial"].includes(metrics.state)
        ? `本轮采集 ${metrics.collected} 条 → 筛选后 ${metrics.afterFilter} 条`
        : "本轮未完成原生采集，不能按 0 条理解";
    const countNote = metrics?.filterDescription ? `<p class="collection-note">${escapeHtml(metrics.filterDescription)}</p>` : "";
    const note = item.collectionNote ? `<p class="collection-note">${escapeHtml(item.collectionNote)}</p>` : "";
    return `<article class="source-card collection-card"><p class="source-kind">采集与核验路线</p><h3>${escapeHtml(item.organization)}</h3><p>${escapeHtml(item.collectionMethod)}</p><p class="coverage">${item.coverage.map(escapeHtml).join(" · ")}</p>${note}${latest}<p class="check-note"><strong>${escapeHtml(counts)}</strong></p>${countNote}<a href="${escapeHtml(item.collectionEntryUrl)}" target="_blank" rel="noreferrer">查看采集入口 ↗</a></article>`;
  }
  return `<article class="source-card"><p class="source-kind">官方快捷入口</p><h3>${escapeHtml(item.organization)}</h3><p>${escapeHtml(item.type || "官方来源")}</p><p class="coverage">${item.coverage.map(escapeHtml).join(" · ")}</p><p class="check-note">不显示采集状态</p><a href="${escapeHtml(item.entryUrl)}" target="_blank" rel="noreferrer">打开官网 ↗</a></article>`;
}

function renderSources(sources) {
  byId("source-list").innerHTML = sources.length ? sources.map(sourceCard).join("") : "<p class=\"empty-state\">这个城市还没有导入信息源。</p>";
}

function renderUpdates(runs) {
  byId("update-list").innerHTML = runs.length ? runs.slice(0, 12).map((run) => `<article class="update-item"><div><strong>${escapeHtml(dateLabel(run.checkedAt))}</strong><span class="run-status">${escapeHtml(run.status || "已完成")}</span></div><p>${escapeHtml(run.summary || run.outcome || "已完成公开信息核验。")}</p></article>`).join("") : "<p class=\"empty-state\">尚未导入更新记录。</p>";
}

async function loadPageData() {
  const city = state.cities.find((item) => item.id === state.cityId);
  if (!city) return;
  updateLastChecked(city);
  if (page === "jobs") {
    byId("current-city-label").textContent = `${city.name} · 岗位信息`;
    byId("job-heading").textContent = `${city.name}的具体岗位`;
    const parameters = new URLSearchParams();
    if (state.query.trim()) parameters.set("q", state.query.trim());
    const { opportunities } = await api(`/api/cities/${state.cityId}/opportunities?${parameters}`);
    renderJobs(opportunities);
    return;
  }
  if (page === "announcements") {
    byId("announcement-heading").textContent = `${city.name}的考试公告`;
    const { opportunities } = await api(`/api/cities/${state.cityId}/opportunities?kind=monitor`);
    renderAnnouncements(opportunities);
    return;
  }
  if (page === "sources") {
    byId("source-heading").textContent = state.sourceView === "collection" ? `${city.name}的采集与核验路线` : `${city.name}的官方快捷入口`;
    byId("source-intro").textContent = state.sourceView === "collection" ? "这里展示实际运行的采集入口，不等同于左侧的政府快捷入口；采集结果会带着证据状态进入岗位页。" : "方便直接进入各个官方平台，不显示采集状态。";
    const { sources } = await api(`/api/cities/${state.cityId}/sources?view=${state.sourceView}`);
    renderSources(sources);
    return;
  }
  byId("update-heading").textContent = `${city.name}的更新记录`;
  const { runs } = await api(`/api/cities/${state.cityId}/audit`);
  renderUpdates(runs);
}

async function selectCity(cityId) {
  state.cityId = cityId;
  localStorage.setItem("menglin-radar-city", cityId);
  renderCities();
  await loadPageData();
}

async function toggleFavorite(opportunityId) {
  const key = favoriteKey(state.cityId, opportunityId);
  const method = state.favorites.has(key) ? "DELETE" : "POST";
  try {
    const { favorites } = await api("/api/favorites", { method, favorite: true, body: JSON.stringify({ cityId: state.cityId, opportunityId }) });
    state.favorites = new Set(favorites.map((item) => favoriteKey(item.cityId, item.opportunityId)));
    byId("favorite-count").textContent = state.favorites.size;
    await loadPageData();
  } catch (error) {
    window.alert(error.message);
  }
}

function setupJobsPage() {
  document.querySelectorAll("[data-track]").forEach((button) => {
    button.classList.toggle("active", button.dataset.track === state.track);
    button.addEventListener("click", async () => {
      state.track = button.dataset.track;
      document.querySelectorAll("[data-track]").forEach((item) => item.classList.toggle("active", item === button));
      await loadPageData();
    });
  });
  let timer;
  byId("search").addEventListener("input", (event) => {
    clearTimeout(timer);
    timer = setTimeout(async () => { state.query = event.target.value; await loadPageData(); }, 220);
  });
}

function setupSourcesPage() {
  document.querySelectorAll("[data-source-view]").forEach((button) => button.addEventListener("click", async () => {
    state.sourceView = button.dataset.sourceView;
    document.querySelectorAll("[data-source-view]").forEach((item) => {
      const selected = item === button;
      item.classList.toggle("active", selected);
      item.setAttribute("aria-selected", String(selected));
    });
    await loadPageData();
  }));
}

function setupFavoriteDialog() {
  const dialog = byId("favorite-dialog");
  if (!dialog) return;
  const input = byId("favorite-code");
  const manage = byId("manage-code");
  const copy = byId("copy-code");
  const save = byId("save-code");
  const feedback = byId("code-feedback");
  // A missing optional dialog control should never prevent city data or
  // opportunities from rendering on the rest of the page.
  if (!input || !manage || !copy || !save || !feedback) return;
  manage.addEventListener("click", () => { input.value = ensureCode(); feedback.textContent = ""; dialog.showModal(); });
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(input.value); feedback.textContent = "已复制。请保存在可信的位置。"; }
    catch { input.select(); feedback.textContent = "请手动复制这串代码。"; }
  });
  save.addEventListener("click", async () => {
    if (!/^mlr_[A-Za-z0-9_-]{40,160}$/.test(input.value.trim())) { feedback.textContent = "这不是有效的收藏代码。"; return; }
    state.code = input.value.trim();
    localStorage.setItem("menglin-radar-favorite-code", state.code);
    await loadFavorites();
    await loadPageData();
    feedback.textContent = "已同步这串代码对应的收藏。";
  });
}

function updateAdminControls() {
  const loggedIn = Boolean(state.adminSession);
  document.querySelectorAll("[data-admin-trigger]").forEach((trigger) => { trigger.textContent = loggedIn ? "管理员已登录" : "管理员"; });
  const fields = byId("admin-login-fields");
  const login = byId("admin-login");
  const logout = byId("admin-logout");
  const sync = byId("run-full-sync");
  const controls = byId("admin-update-controls");
  const copy = byId("admin-login-copy");
  if (fields) fields.hidden = loggedIn;
  if (login) login.hidden = loggedIn;
  if (logout) logout.hidden = !loggedIn;
  if (sync) sync.hidden = !loggedIn;
  if (controls) controls.hidden = !loggedIn;
  if (copy) copy.textContent = loggedIn
    ? `已登录为 ${state.adminUsername || "管理员"}。可以立即更新，或调整服务器的每日更新计划。`
    : "登录后可以控制四座城市何时执行完整更新。";
}

async function refreshCitiesAndPage() {
  const { cities } = await api("/api/cities");
  state.cities = cities;
  if (!state.cities.some((city) => city.id === state.cityId)) state.cityId = state.cities[0]?.id || "beijing";
  renderCities();
  await loadPageData();
}

async function restoreAdminSession() {
  if (!state.adminSession) return;
  try {
    const session = await api("/api/admin/session", { admin: true });
    state.adminUsername = session.username;
  } catch {
    state.adminSession = "";
    sessionStorage.removeItem("menglin-radar-admin-session");
  }
}

function setupAdminDialog() {
  const dialog = byId("admin-dialog");
  if (!dialog) return;
  const feedback = byId("admin-feedback");
  const username = byId("admin-username");
  const password = byId("admin-password");
  const login = byId("admin-login");
  const logout = byId("admin-logout");
  const sync = byId("run-full-sync");
  const saveSchedule = byId("save-update-schedule");
  document.querySelectorAll("[data-admin-trigger]").forEach((trigger) => trigger.addEventListener("click", async () => {
    updateAdminControls();
    if (feedback) feedback.textContent = "";
    dialog.showModal();
    if (state.adminSession) await loadAdminSchedule();
  }));
  login?.addEventListener("click", async () => {
    try {
      const result = await api("/api/admin/session", { method: "POST", body: JSON.stringify({ username: username.value, password: password.value }) });
      state.adminSession = result.token;
      state.adminUsername = result.username;
      sessionStorage.setItem("menglin-radar-admin-session", result.token);
      password.value = "";
      updateAdminControls();
      feedback.textContent = "管理员已登录。";
      await loadAdminSchedule();
    } catch (error) { feedback.textContent = error.message; }
  });
  logout?.addEventListener("click", async () => {
    try { await api("/api/admin/session", { method: "DELETE", admin: true }); } catch { /* expired sessions are still cleared locally */ }
    state.adminSession = "";
    state.adminUsername = "";
    sessionStorage.removeItem("menglin-radar-admin-session");
    updateAdminControls();
    feedback.textContent = "已退出管理员账号。";
    await loadPageData();
  });
  sync?.addEventListener("click", async () => {
    try {
      const result = await api("/api/admin/sync", { method: "POST", admin: true, body: JSON.stringify({}) });
      feedback.textContent = result.alreadyRunning ? "完整更新已在进行中。" : "已开始四城完整更新；可以关闭窗口，完成后刷新岗位页查看结果。";
      await waitForSync(feedback);
    } catch (error) { feedback.textContent = error.message; }
  });
  saveSchedule?.addEventListener("click", async () => {
    const enabled = byId("update-schedule-enabled").checked;
    const times = byId("update-schedule-times").value.split(/[,，、;；\s]+/).map((value) => value.trim()).filter(Boolean);
    try {
      const schedule = await api("/api/admin/schedule", {
        method: "PUT",
        admin: true,
        body: JSON.stringify({ enabled, times }),
      });
      renderAdminSchedule(schedule);
      feedback.textContent = schedule.enabled ? "更新计划已保存，服务器会按时自动运行。" : "更新计划已保存，自动运行已关闭。";
    } catch (error) { feedback.textContent = error.message; }
  });
}

function renderAdminSchedule(schedule) {
  byId("update-schedule-enabled").checked = schedule.enabled;
  byId("update-schedule-times").value = schedule.times.join(", ");
  const next = schedule.nextRunAt ? `下次运行：${dateLabel(schedule.nextRunAt)}` : "自动更新当前未启用";
  const last = schedule.lastTriggeredAt ? `；上次定时触发：${dateLabel(schedule.lastTriggeredAt)}` : "";
  byId("update-schedule-status").textContent = `${next}${last}`;
}

async function loadAdminSchedule() {
  try {
    renderAdminSchedule(await api("/api/admin/schedule", { admin: true }));
  } catch (error) {
    byId("admin-feedback").textContent = error.message;
  }
}

async function waitForSync(feedback) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    await new Promise((resolveWait) => window.setTimeout(resolveWait, 3_000));
    const status = await api("/api/admin/sync", { admin: true });
    if (status.state === "running") continue;
    if (status.state === "completed" || status.state === "completed-partial") {
      const summary = status.summary;
      feedback.textContent = `更新完成：${summary.importedCityCount} 个城市已导入${summary.failedCityCount ? `，${summary.failedCityCount} 个城市未通过本轮门禁` : ""}。`;
      await refreshCitiesAndPage();
      return;
    }
    feedback.textContent = status.error || "统一更新未完成，请查看管理员接口记录。";
    return;
  }
  feedback.textContent = "更新仍在运行，可稍后重新打开管理员窗口查看状态。";
}

async function bootstrap() {
  if (page === "jobs") setupJobsPage();
  if (page === "sources") setupSourcesPage();
  setupFavoriteDialog();
  setupAdminDialog();
  try {
    await restoreAdminSession();
    updateAdminControls();
    const { cities } = await api("/api/cities");
    state.cities = cities;
    if (!state.cities.length) return;
    if (!state.cities.some((city) => city.id === state.cityId)) state.cityId = state.cities[0].id;
    renderCities();
    await loadFavorites();
    await loadPageData();
  } catch (error) {
    const firstContent = document.querySelector(".page-content, .opportunity-list");
    if (firstContent) firstContent.innerHTML = `<div class="empty-state"><strong>暂时无法读取数据</strong><p>${escapeHtml(error.message)}</p></div>`;
  }
}

bootstrap();
