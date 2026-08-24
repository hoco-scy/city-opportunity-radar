import test from "node:test";
import assert from "node:assert/strict";
import { classifyJqzpDetail, collectJqzpBeijingSoe } from "../scripts/collect-jqzp-beijing-soe.mjs";

const now = new Date("2026-08-24T02:00:00Z");
const checkedAt = "2026-08-24T10:00:00+08:00";

function response(data, url) {
  return { ok: true, status: 200, url, json: async () => data };
}

function listRow(overrides = {}) {
  return {
    id: 101,
    publicName: "医疗器械产品研发岗",
    businessName: "北京示例医疗科技有限公司",
    workCityName: "北京市",
    workDistrictName: "海淀区",
    workYear: 1,
    workYearName: "应届生",
    degreeName: "硕士",
    businessQualityName: "国有企业",
    recruitmentType: 2,
    recruitmentTypeName: "校园招聘",
    majorName: "生物医学工程",
    orderEndTime: "2099-12-31",
    ...overrides
  };
}

function detailRow(overrides = {}) {
  return {
    ...listRow(),
    publishStatus: 2,
    offlineFlag: 0,
    cityName: "北京市",
    number: "2",
    description: "任职要求\n生物医学工程、医疗器械工程相关专业，硕士研究生。\n岗位职责：\n负责医疗器械研发和产品验证。",
    orderStartTime: "2026-08-01",
    refreshTime: "2026-08-20 10:00:00",
    ...overrides
  };
}

test("京企直聘先使用北京、应届、校招和国企原生筛选，再只打开专业可能可报的详情", async () => {
  const calls = [];
  const result = await collectJqzpBeijingSoe({
    city: "北京",
    now,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith("/getPosition")) {
        const body = JSON.parse(init.body);
        assert.equal(body.workCityId, 33);
        assert.equal(body.workYear, 1);
        assert.equal(body.businessQuality, 5);
        assert.equal(body.recruitmentType, 2);
        assert.equal(body.jobPostingType, "2");
        assert.equal(parsed.searchParams.get("searchWord"), "");
        const page = Number(parsed.searchParams.get("from"));
        return response({ code: 200, count: 101, data: page === 0 ? [
          listRow(),
          listRow({ id: 102, publicName: "财务会计", majorName: "会计学" }),
          listRow({ id: 103, publicName: "AI 算法工程师", majorName: "生物医学工程" })
        ] : [] }, String(url));
      }
      if (parsed.pathname.endsWith("/getPositionDetailed")) {
        const id = Number(parsed.searchParams.get("postId"));
        return response({ code: 200, data: [id === 103
          ? detailRow({ id, publicName: "AI 算法工程师", description: "任职要求\n生物医学工程专业。\n岗位职责：\n负责通用大模型训练。" })
          : detailRow({ id })] }, String(url));
      }
      throw new Error(`unexpected request: ${url}`);
    }
  });

  assert.equal(result.portalResultsReported, 101);
  assert.equal(result.nativeFilteredResults, 3);
  assert.equal(result.detailsChecked, 2);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].sourceId, "jqzp-beijing-soe");
  assert.match(result.jobs[0].officialApplyUrl, /positiondetails\?infoid=/);
  assert.equal(result.detailOutcomes["professional-unmatched"], 1);
  assert.equal(result.detailOutcomes["pure-computing-role-mismatch"], 1);
  assert.equal(calls.filter((call) => new URL(call.url).pathname.endsWith("/getPosition")).length, 2);
});

test("京企直聘详情排除博士专属、明确工作经验和高危岗位", () => {
  assert.equal(classifyJqzpDetail(detailRow({ degreeName: "博士" }), checkedAt, now).outcome, "education-mismatch");
  assert.equal(classifyJqzpDetail(detailRow({ description: "任职要求：生物医学工程专业，3年以上相关工作经验。" }), checkedAt, now).outcome, "experience-mismatch");
  assert.equal(classifyJqzpDetail(detailRow({ description: "任职要求：生物医学工程专业。岗位职责：长期井下作业。" }), checkedAt, now).outcome, "objective-high-risk");
  assert.equal(classifyJqzpDetail(detailRow({ publicName: "瓶箱保管员", majorName: "不限专业", description: "任职要求：不限专业。岗位职责：负责瓶箱保管。" }), checkedAt, now).outcome, "clearly-low-quality-role");
});

test("京企直聘保留不限专业和工学可报岗位，不要求标题必须出现医学词", () => {
  const open = classifyJqzpDetail(detailRow({
    id: 104,
    publicName: "产品策划岗",
    majorName: "不限专业",
    description: "任职要求：不限专业，硕士研究生。岗位职责：负责产品规划与协同。"
  }), checkedAt, now);
  assert.equal(open.outcome, "accepted");
  assert.equal(open.job.professionalEligibility.basis, "open");

  const engineering = classifyJqzpDetail(detailRow({
    id: 105,
    publicName: "质量管理岗",
    majorName: "工学门类",
    description: "任职要求：工学门类均可报名。岗位职责：负责产品质量体系。"
  }), checkedAt, now);
  assert.equal(engineering.outcome, "accepted");
  assert.equal(engineering.job.professionalEligibility.basis, "broad-engineering");
});
