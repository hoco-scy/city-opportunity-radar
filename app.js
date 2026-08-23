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
      <span>${escapeHtml(city.name)}</span><small>${city.opportunity_count} 条已核验信息</small>
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
  const filtered = state.track === "我的收藏"
    ? opportunities.filter((item) => state.favorites.has(favoriteKey(state.cityId, item.id)))
    : opportunities;
  list.innerHTML = filtered.length ? filtered.map(jobCard).join("") : `<div class="empty-state"><strong>${state.track === "我的收藏" ? "还没有收藏岗位" : "没有符合当前条件的公开岗位"}</strong><p>${state.track === "我的收藏" ? "点击岗位右上角的心形按钮，收藏会自动同步到这串收藏代码。" : "换一个赛道或关键词看看。"}</p></div>`;
  document.querySelectorAll("[data-save]").forEach((button) => button.addEventListener("click", () => toggleFavorite(button.dataset.save)));
}

function jobCard(item) {
  const saved = state.favorites.has(favoriteKey(state.cityId, item.id));
  const tags = (item.tags || []).slice(0, 6).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("");
  const applicationUrl = item.officialApplyUrl || item.officialAnnouncementUrl;
  return `<article class="opportunity-card"><div class="card-accent" data-track="${escapeHtml(item.track)}"></div><div class="card-content"><div class="card-topline"><span class="track-tag track-${escapeHtml(item.track)}">${escapeHtml(item.track)}</span><span class="official-tag">已核验</span><button class="save-button ${saved ? "saved" : ""}" data-save="${escapeHtml(item.id)}" aria-label="${saved ? "取消收藏" : "收藏"} ${escapeHtml(item.exactTitle || item.title)}" type="button">${saved ? "♥" : "♡"}</button></div><div class="card-title-row"><div><h3>${escapeHtml(item.exactTitle || item.title)}</h3><p>${escapeHtml(item.organization)} · ${escapeHtml(item.location || "地点以官网为准")}</p></div><div class="match-score"><strong>${escapeHtml(item.priority ?? "—")}</strong><span>关注度</span></div></div><p class="match-reason">${escapeHtml(item.matchReason || "已回到官方岗位页核验关键信息。")}</p><div class="tag-row">${tags}</div><div class="card-footer"><div><span class="status-pill">${escapeHtml(item.status || "以官网为准")}</span><span class="deadline">${escapeHtml(item.deadline || "截止时间以官网为准")}</span><span class="verified-date">核验 ${escapeHtml(item.verifiedAt || "")}</span></div>${applicationUrl ? `<a href="${escapeHtml(applicationUrl)}" target="_blank" rel="noreferrer">官方岗位页 ↗</a>` : ""}</div></div></article>`;
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
    const note = item.collectionNote ? `<p class="collection-note">${escapeHtml(item.collectionNote)}</p>` : "";
    return `<article class="source-card collection-card"><p class="source-kind">采集与核验路线</p><h3>${escapeHtml(item.organization)}</h3><p>${escapeHtml(item.collectionMethod)}</p><p class="coverage">${item.coverage.map(escapeHtml).join(" · ")}</p>${note}${latest}<a href="${escapeHtml(item.collectionEntryUrl)}" target="_blank" rel="noreferrer">查看采集入口 ↗</a></article>`;
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
    byId("current-city-label").textContent = `${city.name} · 已核验信息`;
    byId("job-heading").textContent = `${city.name}的具体岗位`;
    const parameters = new URLSearchParams();
    if (state.track !== "全部" && state.track !== "我的收藏") parameters.set("track", state.track);
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
    byId("source-intro").textContent = state.sourceView === "collection" ? "这里展示实际运行的采集入口，不等同于左侧的政府快捷入口；只有完成官方核验的信息才会进入岗位或公告页面。" : "方便直接进入各个官方平台，不显示采集状态。";
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

async function bootstrap() {
  if (page === "jobs") setupJobsPage();
  if (page === "sources") setupSourcesPage();
  setupFavoriteDialog();
  try {
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
