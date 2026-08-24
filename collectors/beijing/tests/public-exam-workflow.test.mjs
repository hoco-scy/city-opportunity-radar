import test from "node:test";
import assert from "node:assert/strict";
import { collectPublicExamWorkflowSources } from "../scripts/public-exam-workflow.mjs";

function mockFetch(routes) {
  return async (input) => {
    const response = routes[String(input)];
    if (!response) throw new Error(`unexpected request: ${input}`);
    return new Response(response.body, {
      status: response.status ?? 200,
      headers: { "content-type": "text/html" }
    });
  };
}

test("records a current public-exam announcement anonymously and never publishes it as a job", async () => {
  const entry = "https://www.beijing.gov.cn/gongkai/rsxx/gwyzk/";
  const detail = "https://www.beijing.gov.cn/gongkai/rsxx/gwyzk/209910/t20991015_1.html";
  const outcomes = await collectPublicExamWorkflowSources({
    registry: { sources: [{ id: "beijing-civil", organization: "北京市公务员招考主管部门", entryUrl: entry, domains: ["beijing.gov.cn"] }] },
    recipes: { recipes: [{ sourceId: "beijing-civil", collection: { primary: "script" } }] },
    fetchImpl: mockFetch({
      [entry]: { body: '<a href="./209910/t20991015_1.html" title="北京市各级机关2099年度考试录用公务员公告">公告</a>' },
      [detail]: { body: "网上报名：2099年10月20日至11月5日。" }
    })
  });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].sourceCheck.status, "checked-deferred");
  assert.equal(outcomes[0].reviews.length, 1);
  assert.equal(outcomes[0].reviews[0].scope, "official-announcement");
  assert.equal(outcomes[0].reviews[0].decision, "deferred");
  assert.match(outcomes[0].reviews[0].reason, /私有资格/);
  assert.equal("job" in outcomes[0].reviews[0], false);
});

test("records a current Beijing selection announcement from the selected-university public route anonymously", async () => {
  const entry = "https://rsj.beijing.gov.cn/xxgk/tzgg/";
  const config = "https://career.buaa.edu.cn/frontpage/buaa/js/init.js";
  const feed = "https://career.buaa.edu.cn/f/newsCenter/ajax_list";
  const detail = "https://career.buaa.edu.cn/f/newsCenter/ajax_view?id=selection-2099";
  const title = "北京市2099年度定向选调和“优培计划”招聘应届优秀大学毕业生公告";
  const outcomes = await collectPublicExamWorkflowSources({
    registry: { sources: [{ id: "beijing-selection-program", organization: "北京市选调优培公告", entryUrl: entry, domains: ["rsj.beijing.gov.cn"] }] },
    recipes: { recipes: [{ sourceId: "beijing-selection-program", collection: { primary: "script" } }] },
    fetchImpl: mockFetch({
      [config]: { body: "window._config = { token: 'public-token' };" },
      [feed]: { body: JSON.stringify({ state: 1, object: { newsPage: { totalPage: 1, list: [{ id: "selection-2099", title, releaseDate: "2099-09-08", url: "/frontpage/buaa/html/newsDetail.html?id=selection-2099" }] } } }) },
      [detail]: { body: JSON.stringify({ state: 1, object: { article: {
        title,
        releaseDate: "2099-09-08",
        articleData: { content: "<p>北京市人力资源和社会保障局</p><p>面向应届优秀大学毕业生。</p><p>网上报名：2099年10月20日至11月5日。</p>" }
      }, fileMap: [] } }) }
    })
  });
  assert.equal(outcomes[0].reviews.length, 1);
  assert.equal(outcomes[0].reviews[0].reasonCode, "private-eligibility-check-required");
  assert.equal(outcomes[0].reviews[0].decision, "deferred");
  assert.match(outcomes[0].reviews[0].deadline, /2099-11-05/);
});
