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

test("keeps an explicit undated pre-announcement but drops one with an expired registration window", async () => {
  const entry = "https://rsj.beijing.gov.cn/xxgk/tzgg/";
  const pre = "https://rsj.beijing.gov.cn/xxgk/tzgg/209910/t20991015_1.html";
  const expired = "https://rsj.beijing.gov.cn/xxgk/tzgg/202605/t20260515_2.html";
  const outcomes = await collectPublicExamWorkflowSources({
    registry: { sources: [{ id: "beijing-selection-program", organization: "北京市选调优培公告", entryUrl: entry, domains: ["rsj.beijing.gov.cn"] }] },
    recipes: { recipes: [{ sourceId: "beijing-selection-program", collection: { primary: "script" } }] },
    fetchImpl: mockFetch({
      [entry]: { body: '<a href="./209910/t20991015_1.html" title="北京市2099年度优培计划预公告">预公告</a><a href="./202605/t20260515_2.html" title="北京市2026年度优培计划预公告">旧预公告</a>' },
      [pre]: { body: "职位表和报名安排将另行公布。" },
      [expired]: { body: "报名时间为2026年5月8日至10日。" }
    })
  });
  assert.equal(outcomes[0].reviews.length, 1);
  assert.equal(outcomes[0].reviews[0].reasonCode, "official-preannouncement-position-table-pending");
  assert.match(outcomes[0].reviews[0].deadline, /待官方公布/);
});
