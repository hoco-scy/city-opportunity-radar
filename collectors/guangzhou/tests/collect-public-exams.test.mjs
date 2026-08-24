import test from "node:test";
import assert from "node:assert/strict";
import AdmZip from "adm-zip";
import * as XLSX from "xlsx";
import {
  collectBeijingCivil,
  collectGuangdongCivil,
  collectNationalCivil,
  collectPublicExam,
  collectShanghaiSelectionProgram,
  collectShanghaiCivil,
  collectStaticSelectionProgram,
  diffSnapshots,
  extractApplicationLifecycle,
  parseNationalCoreConstants,
  parsePositionWorkbook
} from "../scripts/collect-public-exams.mjs";

function json(value) {
  return JSON.stringify(value);
}

function mockFetch(routes) {
  return async (input) => {
    const key = String(input);
    const response = routes[key];
    if (!response) throw new Error(`unexpected request: ${key}`);
    if (response instanceof Error) throw response;
    return new Response(response.body, {
      status: response.status ?? 200,
      headers: response.headers ?? { "content-type": typeof response.body === "string" ? "text/html" : "application/octet-stream" }
    });
  };
}

function workbookBuffer() {
  const sheet = XLSX.utils.aoa_to_sheet([
    ["招录机关", "职位名称", "职位代码", "工作地点", "专业要求", "学历要求"],
    ["广州市某局", "医疗器械监管", "1001", "广州市", "生物医学工程", "硕士研究生"],
    ["深圳市某局", "医疗器械监管", "1002", "深圳市", "生物医学工程", "硕士研究生"]
  ]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "职位表");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
}

test("parses the stateful national SPA configuration instead of guessing a yearly URL", () => {
  const parsed = parseNationalCoreConstants('neu.hb01Id = "topic-2027"; neu.cdnServer = "http://dl.scs.gov.cn";');
  assert.equal(parsed.topicId, "topic-2027");
  assert.equal(parsed.apiOrigin, "http://dl.scs.gov.cn");
});

test("recognizes closed registration ranges even when a government CMS splits date digits across spans", () => {
  const lifecycle = extractApplicationLifecycle(
    "<p>报名时间为 <span>202</span><span>6</span>年5月8日8:00至10日18:00。</p>",
    new Date("2026-08-23T00:00:00+08:00")
  );
  assert.equal(lifecycle.status, "expired");
  assert.equal(lifecycle.deadline, "2026-05-10");
});

test("recognizes a future cross-month registration deadline", () => {
  const lifecycle = extractApplicationLifecycle(
    "网上报名：2099年10月20日至11月5日。",
    new Date("2026-08-23T00:00:00+08:00")
  );
  assert.equal(lifecycle.status, "open-or-upcoming");
  assert.equal(lifecycle.deadline, "2099-11-05");
});

test("uses the registration window rather than a later graduation deadline in the same announcement", () => {
  const lifecycle = extractApplicationLifecycle(
    "报名时间为2025年12月4日9:00至8日16:00；报考者最高学历毕业证书应于2026年9月30日前取得。",
    new Date("2026-08-23T00:00:00+08:00"),
    { title: "广东省2026年度选调优秀大学毕业生公告" }
  );
  assert.equal(lifecycle.status, "expired");
  assert.equal(lifecycle.deadline, "2025-12-08");
});

test("collects national notices from the official public JSON path and keeps an official attachment", async () => {
  const main = "http://bm.scs.gov.cn/pp/gkweb/core/web/ui/business/home/gkhome.html";
  const supplemental = "http://subb.scs.gov.cn/pp/gkweb/core/web/ui/business/home/lxhome.html";
  const constant = "http://dl.scs.gov.cn/core-constant.js";
  const feed = "http://dl.scs.gov.cn/api/gkhome/article/topic-2027";
  const detail = "http://dl.scs.gov.cn/api/article/a1";
  const fetchImpl = mockFetch({
    [main]: { body: '<script src="http://dl.scs.gov.cn/core-constant.js"></script>' },
    [supplemental]: { body: '<script src="http://dl.scs.gov.cn/core-constant.js"></script>' },
    [constant]: { body: 'neu.hb01Id = "topic-2027"; neu.cdnServer = "http://dl.scs.gov.cn";' },
    [feed]: { body: json({ articleGroupList: [{ title: "招考公告", articleList: [{ id: "a1", articleTitle: "中央机关及其直属机构2027年度考试录用公务员公告", pstrtime: "2026-10-14" }] }] }) },
    [detail]: { body: json({ article: { articleTitle: "中央机关及其直属机构2027年度考试录用公务员公告", content: '<a href="/download/position.xlsx">职位表</a>' }, resourceList: [] }) }
  });
  const result = await collectNationalCivil({ fetchImpl });
  assert.equal(result.collectionMethod, "script");
  assert.equal(result.noticeCount, 1);
  assert.equal(result.notices[0].attachments[0].officialUrl, "http://dl.scs.gov.cn/download/position.xlsx");
  assert.equal(result.status, "completed");
});

test("collects Beijing static notices and discovers its attached position table", async () => {
  const entry = "https://www.beijing.gov.cn/gongkai/rsxx/gwyzk/";
  const notice = "https://www.beijing.gov.cn/gongkai/rsxx/gwyzk/202610/t20261015_1.html";
  const fetchImpl = mockFetch({
    [entry]: { body: `<a href="./202610/t20261015_1.html" title="北京市各级机关2027年度考试录用公务员公告">公告</a><span>2026-10-15</span>` },
    [notice]: { body: '<a href="./position.xlsx">附件1：职位表</a>' }
  });
  const result = await collectBeijingCivil({ fetchImpl });
  assert.equal(result.noticeCount, 1);
  assert.equal(result.notices[0].category, "recruitment-announcement");
  assert.equal(result.notices[0].attachments[0].officialUrl, "https://www.beijing.gov.cn/gongkai/rsxx/gwyzk/202610/position.xlsx");
});

test("collects a standalone official selection-program announcement and retains its lifecycle", async () => {
  const entry = "https://rsj.beijing.gov.cn/xxgk/tzgg/";
  const notice = "https://rsj.beijing.gov.cn/xxgk/tzgg/209910/t20991015_1.html";
  const fetchImpl = mockFetch({
    [entry]: { body: '<a href="./209910/t20991015_1.html" title="北京市2099年度定向选调和优培毕业生公告">公告</a>' },
    [notice]: { body: "网上报名：2099年10月20日至11月5日。<a href=\"./positions.xlsx\">附件1：职位表</a>" }
  });
  const result = await collectStaticSelectionProgram({ sourceId: "beijing-selection-program", fetchImpl });
  assert.equal(result.noticeCount, 1);
  assert.equal(result.notices[0].category, "selection-program");
  assert.equal(result.notices[0].lifecycle.status, "open-or-upcoming");
  assert.equal(result.notices[0].attachments[0].officialUrl, "https://rsj.beijing.gov.cn/xxgk/tzgg/209910/positions.xlsx");
});

test("discovers a selection notice when the official list exposes only a script URL", async () => {
  const entry = "https://rsj.beijing.gov.cn/xxgk/tzgg/";
  const notice = "https://rsj.beijing.gov.cn/xxgk/tzgg/209910/t20991016_2.html";
  const fetchImpl = mockFetch({
    [entry]: { body: '<script>const record = {"title":"","url":"./209910/t20991016_2.html"};</script>' },
    [notice]: { body: "<h1>北京市2099年度定向选调应届优秀大学毕业生公告</h1>网上报名：2099年10月20日至11月5日。" }
  });
  const result = await collectStaticSelectionProgram({ sourceId: "beijing-selection-program", fetchImpl });
  assert.equal(result.noticeCount, 1);
  assert.equal(result.notices[0].title, "北京市2099年度定向选调应届优秀大学毕业生公告");
});

test("uses the official mobile detail fallback when a Beijing CMS list URL is stale", async () => {
  const entry = "https://rsj.beijing.gov.cn/xxgk/tzgg/";
  const notice = "https://rsj.beijing.gov.cn/xxgk/tzgg/209910/t20991017_3.html";
  const fallback = "https://rsj.beijing.gov.cn/xxgk/tzgg/209910/t20991017_3_ext.html";
  const fetchImpl = mockFetch({
    [entry]: { body: '<script>const record = {"title":"","url":"./209910/t20991017_3.html"};</script>' },
    [notice]: { status: 404, body: "not found" },
    [fallback]: { body: "<title>北京市2099年度优培计划招聘公告</title>网上报名：2099年10月20日至11月5日。" }
  });
  const result = await collectStaticSelectionProgram({ sourceId: "beijing-selection-program", fetchImpl });
  assert.equal(result.status, "completed");
  assert.equal(result.noticeCount, 1);
  assert.equal(result.notices[0].officialUrl, fallback);
});

test("collects Shanghai notices through the official API hierarchy", async () => {
  const sections = "https://shacs.gov.cn/gwyj/api/gwy-column-section.json?listChild=true";
  const news = "https://shacs.gov.cn/gwyj/api/child-section-and-news.json?sectionId=407&pageSize=2000";
  const detail = "https://shacs.gov.cn/gwyj/api/show-news.json?id=1284";
  const fetchImpl = mockFetch({
    [sections]: { body: json({ state: "SUCCESS", result: { child: [{ id: 407, name: "上海市2027年度考试录用公务员专题" }] } }) },
    [news]: { body: json({ state: "SUCCESS", result: { secNews: { list: [{ id: 1284, title: "上海市2027年度考试录用公务员公告", postDate: "2026-11-01" }] } } }) },
    [detail]: { body: json({ state: "SUCCESS", result: { title: "上海市2027年度考试录用公务员公告", postDate: "2026-11-01", content: '<a href="/files/position.xlsx">职位表</a>' } }) }
  });
  const result = await collectShanghaiCivil({ fetchImpl });
  assert.equal(result.noticeCount, 1);
  assert.equal(result.notices[0].sectionName, "上海市2027年度考试录用公务员专题");
  assert.equal(result.notices[0].attachments[0].officialUrl, "https://shacs.gov.cn/files/position.xlsx");
});

test("uses Shanghai's official selection topic as a separate collection path", async () => {
  const sections = "https://shacs.gov.cn/gwyj/api/gwy-column-section.json?listChild=true";
  const news = "https://shacs.gov.cn/gwyj/api/child-section-and-news.json?sectionId=408&pageSize=2000";
  const detail = "https://shacs.gov.cn/gwyj/api/show-news.json?id=1285";
  const fetchImpl = mockFetch({
    [sections]: { body: json({ state: "SUCCESS", result: { child: [{ id: 408, name: "上海市2099年度选调优秀大学毕业生专题" }] } }) },
    [news]: { body: json({ state: "SUCCESS", result: { secNews: { list: [{ id: 1285, title: "上海市2099年度选调优秀大学毕业生公告", postDate: "2099-10-01" }] } } }) },
    [detail]: { body: json({ state: "SUCCESS", result: { title: "上海市2099年度选调优秀大学毕业生公告", postDate: "2099-10-01", content: "网上报名：2099年10月20日至11月5日。" } }) }
  });
  const result = await collectShanghaiSelectionProgram({ fetchImpl });
  assert.equal(result.sourceId, "shanghai-selection-program");
  assert.equal(result.noticeCount, 1);
  assert.equal(result.notices[0].category, "selection-program");
});

test("does not fetch ordinary civil-service details while checking the Shanghai selection feed", async () => {
  const sections = "https://shacs.gov.cn/gwyj/api/gwy-column-section.json?listChild=true";
  const selectionNews = "https://shacs.gov.cn/gwyj/api/child-section-and-news.json?sectionId=408&pageSize=2000";
  const civilNews = "https://shacs.gov.cn/gwyj/api/child-section-and-news.json?sectionId=407&pageSize=2000";
  const selectionDetail = "https://shacs.gov.cn/gwyj/api/show-news.json?id=1285";
  const fetchImpl = mockFetch({
    [sections]: { body: json({ state: "SUCCESS", result: { child: [{ id: 408, name: "上海市2099年度选调优秀大学毕业生专题" }, { id: 407, name: "上海市2099年度考试录用公务员专题" }] } }) },
    [selectionNews]: { body: json({ state: "SUCCESS", result: { secNews: { list: [{ id: 1285, title: "上海市2099年度选调优秀大学毕业生公告", postDate: "2099-10-01" }] } } }) },
    [civilNews]: { body: json({ state: "SUCCESS", result: { secNews: { list: [{ id: 1284, title: "上海市2099年度考试录用公务员公告", postDate: "2099-10-01" }] } } }) },
    [selectionDetail]: { body: json({ state: "SUCCESS", result: { title: "上海市2099年度选调优秀大学毕业生公告", postDate: "2099-10-01", content: "网上报名：2099年10月20日至11月5日。" } }) }
  });
  const result = await collectShanghaiSelectionProgram({ fetchImpl });
  assert.equal(result.noticeCount, 1);
  assert.equal(result.errors.length, 0);
});

test("uses Shenzhen's official announcement JSON rather than scraping a rendered list", async () => {
  const feed = "http://www.zzb.sz.gov.cn/postmeta/i/29672.json";
  const detail = "http://www.zzb.sz.gov.cn/notice/announcement/content/post_2099001.html";
  const fetchImpl = mockFetch({
    [feed]: { body: json({ articles: [{ title: "广东省2099年度选调优秀大学毕业生公告", url: detail, date: "2099-10-01" }] }) },
    [detail]: { body: "<h1>广东省2099年度选调优秀大学毕业生公告</h1>网上报名：2099年10月20日至11月5日。" }
  });
  const result = await collectPublicExam({ sourceId: "shenzhen-selection-program", fetchImpl });
  assert.equal(result.collectionRoute, "官方公告 JSON → 公告详情 → 职位表/附件");
  assert.equal(result.noticeCount, 1);
  assert.equal(result.notices[0].category, "selection-program");
});

test("collects Guangzhou-targeted Guangdong selection announcements from the selected-university public category", async () => {
  const config = "https://career.buaa.edu.cn/frontpage/buaa/js/init.js";
  const feed = "https://career.buaa.edu.cn/f/newsCenter/ajax_list";
  const detail = "https://career.buaa.edu.cn/f/newsCenter/ajax_view?id=selection-2099";
  const title = "广东省2099年度选调优秀大学毕业生公告";
  const fetchImpl = mockFetch({
    [config]: { body: "window._config = { token: 'public-token' };" },
    [feed]: { body: json({ state: 1, object: { newsPage: { totalPage: 1, list: [{ id: "selection-2099", title, releaseDate: "2099-10-01", url: "/frontpage/buaa/html/newsDetail.html?id=selection-2099" }] } } }) },
    [detail]: { body: json({ state: 1, object: { article: {
      title,
      releaseDate: "2099-10-01",
      articleData: { content: "<p>中共广东省委组织部</p><p>面向应届优秀大学毕业生。</p><p>网上报名：2099年10月20日至11月5日。</p>" }
    }, fileMap: [] } }) }
  });
  const result = await collectPublicExam({ sourceId: "guangzhou-selection-program", fetchImpl });
  assert.equal(result.collectionRoute, "北航就业网选调生公开栏目 API → 城市应届选调公告详情/附件");
  assert.equal(result.noticeCount, 1);
  assert.equal(result.notices[0].category, "selection-program");
});

test("parses a Guangzhou-filtered official position workbook without asking a browser to open each job", () => {
  const sheets = parsePositionWorkbook(workbookBuffer(), { city: "广州市", fileName: "职位表.xlsx" });
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].totalRows, 2);
  assert.equal(sheets[0].cityFilteredRows.length, 1);
  assert.equal(sheets[0].cityFilteredRows[0].positionCode, "1001");
});

test("collects Guangdong notices and parses only Guangzhou rows from a public ZIP attachment", async () => {
  const entry = "https://www.gdzz.gov.cn/gwygz/lypytzgg/index.html";
  const notice = "https://www.gdzz.gov.cn/gwygz/lypytzgg/content/post_30000.html";
  const archiveUrl = "https://www.gdzz.gov.cn/public/2027-position.zip";
  const archive = new AdmZip();
  archive.addFile("广东省2027年考试录用公务员职位表.xlsx", workbookBuffer());
  const fetchImpl = mockFetch({
    [entry]: { body: `<a href="/gwygz/lypytzgg/content/post_30000.html" title="广东省2027年考试录用公务员公告">公告</a><span>2026-10-19</span>` },
    [notice]: { body: '<a href="/public/2027-position.zip">点击查看：附件1-5</a>' },
    [archiveUrl]: { body: archive.toBuffer(), headers: { "content-type": "application/zip" } }
  });
  const direct = await collectGuangdongCivil({ sourceId: "guangzhou-civil", fetchImpl });
  assert.equal(direct.noticeCount, 1);
  const result = await collectPublicExam({ sourceId: "guangzhou-civil", fetchImpl, parseTables: true });
  assert.equal(result.positionTables.tables.length, 1);
  assert.equal(result.positionTables.tables[0].files[0].sheets[0].cityFilteredRows.length, 1);
  assert.equal(result.positionTables.tables[0].files[0].sheets[0].cityFilteredRows[0].location, "广州市");
});

test("snapshot diff reports new and changed notices without writing public jobs", () => {
  const previous = { notices: { a: { title: "旧公告", officialUrl: "https://example.invalid/a", fingerprint: "old" } } };
  const next = { notices: {
    a: { title: "旧公告修订", officialUrl: "https://example.invalid/a", fingerprint: "new" },
    b: { title: "新公告", officialUrl: "https://example.invalid/b", fingerprint: "fresh" }
  } };
  assert.deepEqual(diffSnapshots(previous, next).map((item) => item.change).sort(), ["changed", "new"]);
});
