import test from "node:test";
import assert from "node:assert/strict";
import {
  CollectionSafetyError,
  buildFilteredUrl,
  collectChinaTelecom,
  parsePositions,
  summarizeCollection
} from "../scripts/collect-chinatelecom.mjs";

const entryUrl = "https://job.chinatelecom.com.cn/wt/TELE/web/index/campus";
const token = "official-current-token";

function page({ total, pages, location = "北京市", title = "医疗健康技术支持类" }) {
  return `
    <script>var url = "/wt/TELE/web/index/webPosition210!getPostListByConditionShowPic?operational=${token}";</script>
    当前页面:&nbsp;1/${pages}&nbsp;&nbsp;共&nbsp;${total}&nbsp;条记录
    <table><tr>
      <td><a title="${title}" href="/wt/TELE/web/index/webPosition210!getOnePosition?postIdEnc=example">${title}</a></td>
      <td><font title="医疗健康">医疗健康</font></td>
      <td title="北京分公司">北京分公司</td>
      <td>1</td>
      <td><font title="${location}">${location}</font></td>
      <td>2026-08-22</td>
    </tr></table>`;
}

function response(html, url) {
  return { ok: true, status: 200, url: String(url), text: async () => html };
}

test("构造的中国电信公开列表请求先带城市筛选，再带分页参数", () => {
  const url = buildFilteredUrl({ entryUrl, operational: token, city: "北京", page: 2, rowSize: 10 });
  assert.equal(url.searchParams.get("workPlace"), "北京");
  assert.equal(url.searchParams.get("recruitType"), "1");
  assert.equal(url.searchParams.get("pc.currentPage"), "2");
  assert.equal(url.searchParams.get("pc.rowSize"), "10");
});

test("解析公开列表为具体岗位及官方详情链接", () => {
  const positions = parsePositions(page({ total: 1, pages: 1 }), entryUrl);
  assert.deepEqual(positions, [{
    title: "医疗健康技术支持类",
    category: "医疗健康",
    organization: "北京分公司",
    headcount: "1",
    location: "北京市",
    publishedAt: "2026-08-22",
    officialUrl: "https://job.chinatelecom.com.cn/wt/TELE/web/index/webPosition210!getOnePosition?postIdEnc=example"
  }]);
});

test("仅在官方城市筛选缩小结果后读取分页", async () => {
  const calls = [];
  const output = await collectChinaTelecom({
    entryUrl,
    city: "北京",
    maxPages: 1,
    fetchImpl: async (url) => {
      calls.push(new URL(url));
      return calls.length === 1 ? response(page({ total: 2264, pages: 227 }), url) : response(page({ total: 3, pages: 1 }), url);
    }
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].searchParams.get("workPlace"), "北京");
  assert.equal(output.unfilteredTotal, 2264);
  assert.equal(output.filteredTotal, 3);
  assert.equal(output.deduplicatedPositions.length, 1);
});

test("地点筛选未缩小结果时拒绝遍历全国岗位", async () => {
  await assert.rejects(
    collectChinaTelecom({
      entryUrl,
      city: "北京",
      fetchImpl: async (url) => response(page({ total: 2264, pages: 227 }), url)
    }),
    CollectionSafetyError
  );
});

test("演示摘要不输出整个筛选结果，只保留可复核的计数和样例", async () => {
  let requestCount = 0;
  const result = await collectChinaTelecom({
    entryUrl,
    city: "北京",
    maxPages: 1,
    fetchImpl: async (url) => response(page({ total: requestCount++ === 0 ? 10 : 1, pages: 1 }), url)
  });
  const summary = summarizeCollection(result);
  assert.equal(summary.deduplicatedPositionCount, 1);
  assert.equal(summary.samplePositions.length, 1);
  assert.equal(summary.deduplicatedPositions, undefined);
});
