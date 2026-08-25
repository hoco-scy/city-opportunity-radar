import assert from "node:assert/strict";
import test from "node:test";
import { collectAiballDiscovery } from "../collectors/beijing/scripts/collect-aiball-discovery.mjs";

function item(overrides = {}) {
  return {
    id: "F18-good",
    title: "人保资本-投资岗-2027届校招",
    organization: "人保资本股权投资有限公司",
    organizationType: "central_soe",
    recruitmentType: "campus",
    recordRole: "position",
    officialUrl: "https://picc.zhiye.com/campus/detail?jobAdId=good",
    applicationUrl: "https://picc.zhiye.com/campus/detail?jobAdId=good",
    publishedAt: "2099-07-31",
    applicationEnd: "2099-12-31",
    applicationStatus: "open",
    deadlineKind: "fixed",
    locationsInScope: ["北京市", "北京市·西城区"],
    eligibilityTags: ["校招", "应届毕业生"],
    decisionNote: "国有金融企业官方校园招聘岗位",
    evidence: [{ field: "major", value: "医学、药学、生命科学专业", excerpt: "硕士研究生及以上学历；医学、药学、生命科学专业可报。" }],
    ...overrides,
  };
}

test("招录雷达采集器使用地区分页，并只留下单位性质与专业资格都合格的具体岗位", async () => {
  const requests = [];
  const result = await collectAiballDiscovery({
    city: "北京",
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      assert.equal(url.pathname, "/api/notices");
      assert.equal(url.searchParams.get("region"), "北京");
      assert.equal(url.searchParams.get("pageSize"), "60");
      const page = Number(url.searchParams.get("page"));
      const items = page === 1 ? [
        item(),
        item({ id: "private", organizationType: "private" }),
        item({ id: "announcement", organizationType: "institution", recordRole: "primary_announcement" }),
      ] : [item({ id: "pure-computing", title: "人工智能工程师", decisionNote: "通用大模型训练" })];
      return { ok: true, status: 200, url: url.toString(), json: async () => ({ total: 61, items }) };
    },
  });
  assert.equal(requests.length, 2);
  assert.equal(result.portalResultsReported, 61);
  assert.equal(result.deduplicatedCandidates, 4);
  assert.equal(result.leads.length, 1);
  assert.equal(result.leads[0].id, "F18-good");
  assert.equal(result.leads[0].location, "北京市·西城区");
  assert.equal(result.leads[0].employerApplyUrl, "https://picc.zhiye.com/campus/detail?jobAdId=good");
  assert.equal(result.leads[0].professionalEligibility.basis, "adjacent");
  assert.equal(result.detailOutcomes["employer-nature-mismatch"], 1);
  assert.equal(result.detailOutcomes["not-specific-position"], 1);
  assert.equal(result.detailOutcomes["pure-computing-role-mismatch"], 1);
});

test("招录雷达采集器不会把已截止岗位重新带回候选池", async () => {
  const result = await collectAiballDiscovery({
    city: "北京",
    fetchImpl: async (input) => ({
      ok: true,
      status: 200,
      url: String(input),
      json: async () => ({ total: 1, items: [item({ applicationEnd: "2020-01-01", applicationStatus: "closed" })] }),
    }),
  });
  assert.equal(result.leads.length, 0);
  assert.equal(result.detailOutcomes.expired, 1);
});
