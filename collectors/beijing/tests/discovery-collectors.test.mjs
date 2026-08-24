import test from "node:test";
import assert from "node:assert/strict";
import { collectBuaaDiscovery } from "../scripts/collect-buaa-discovery.mjs";
import { collectIGuopinDiscovery } from "../scripts/collect-iguopin-discovery.mjs";
import { collectNCSSDiscovery } from "../scripts/collect-ncss-discovery.mjs";

function response(data, url, { text } = {}) {
  return { ok: true, status: 200, url, json: async () => data, text: async () => text ?? JSON.stringify(data) };
}

test("北航采集器只用城市和单位性质缩小列表，并在详情中筛出生物医学工程候选", async () => {
  const calls = [];
  const result = await collectBuaaDiscovery({
    city: "北京",
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), body: String(init.body || "") });
      if (String(url).endsWith("/init.js")) return response(undefined, String(url), { text: "window.config={token:'public-token'}" });
      if (String(url).endsWith("ajax_frontRecruitinfo")) {
        const fields = new URLSearchParams(init.body);
        assert.equal(fields.get("city"), "110000");
        assert.ok(["31", "23", "20"].includes(fields.get("corporationNature")));
        assert.equal(fields.has("title"), false);
        return response({ state: 1, object: { totalPage: 1, count: 1, list: [{ id: "buaa-1", title: "医疗器械研发工程师" }] } }, String(url));
      }
      if (String(url).endsWith("ajax_show")) return response({ state: 1, object: { recruitmentinfo: {
        id: "buaa-1", title: "医疗器械研发工程师", corporationName: "示例医疗器械公司", education: "硕士",
        majorName: "生物医学工程", startTime: "2099-01-01", endTime: "2099-12-31", isFrontShow: "1",
        recruitmentPositionList: [{ cityName: "北京市", positionName: "研发工程师", positionDescription: "医疗器械研发", majorName: "生物医学工程", studentType: "硕士" }]
      } } }, String(url));
      throw new Error(`unexpected request: ${url}`);
    }
  });
  assert.equal(result.nativeFilterQueries, 3);
  assert.equal(result.deduplicatedCandidates, 1);
  assert.equal(result.leads.length, 1);
  assert.equal(result.leads[0].title, "医疗器械研发工程师");
  assert.equal(calls.filter((call) => call.url.endsWith("ajax_frontRecruitinfo")).length, 3);
});

test("国聘采集器使用公开城市关键词分页，并排除无生物医学交叉的通用 AI 岗位", async () => {
  const requestedKeywords = [];
  const result = await collectIGuopinDiscovery({
    city: "北京",
    fetchImpl: async (url, init = {}) => {
      assert.equal(String(url), "https://gp-api.iguopin.com/api/jobs/v1/recom-job");
      const payload = JSON.parse(init.body);
      requestedKeywords.push(payload.search.keyword);
      assert.deepEqual(payload.search.district, ["000000.110000"]);
      const job = payload.search.keyword === "医疗器械" ? {
        job_id: "iguopin-1", status: 1, job_name: "医疗器械研发工程师", company_name: "示例医疗器械公司",
        company_info: { nature_cn: "国企" },
        nature_cn: "校招", education_cn: "硕士", experience_cn: "无经验", major_cn: ["生物医学工程"],
        contents: "面向应届毕业生开展医疗器械研发", apply_instruction: "投递入口：https://jobs.example.org/apply?id=1", start_time: "2099-01-01", end_time: "2099-12-31", district_list: [{ area_cn: "北京" }]
      } : payload.search.keyword === "专业不限" ? {
        job_id: "iguopin-cs", status: 1, job_name: "AI算法工程师", company_name: "示例科技公司",
        company_info: { nature_cn: "国企" },
        nature_cn: "校招", education_cn: "硕士", experience_cn: "无经验", major_cn: ["生物医学工程"],
        contents: "面向应届毕业生从事通用大模型训练", start_time: "2099-01-01", end_time: "2099-12-31", district_list: [{ area_cn: "北京" }]
      } : null;
      return response({ code: 200, data: { total: job ? 1 : 0, list: job ? [job] : [] } }, String(url));
    }
  });
  assert.equal(result.nativeFilterQueries, 11);
  assert.equal(result.deduplicatedCandidates, 2);
  assert.equal(result.leads.length, 1);
  assert.equal(result.leads.find((lead) => lead.id === "iguopin-1").employerNature, "国企");
  assert.equal(result.leads.find((lead) => lead.id === "iguopin-1").employerApplyUrl, "https://jobs.example.org/apply?id=1");
  assert.ok(!result.leads.some((lead) => lead.id === "iguopin-cs"));
  assert.equal(result.detailOutcomes["pure-computing-role-mismatch"], 1);
  assert.equal(new Set(requestedKeywords).size, 11);
});

test("国聘采集器保留官方明确允许工学门类报名的岗位", async () => {
  const result = await collectIGuopinDiscovery({
    city: "北京",
    fetchImpl: async (url, init = {}) => {
      const keyword = JSON.parse(init.body).search.keyword;
      const job = keyword === "工程类" ? {
        job_id: "iguopin-broad", status: 1, job_name: "国际市场助理", company_name: "示例公司",
        company_info: { nature_cn: "国企" },
        nature_cn: "校招", education_cn: "本科", experience_cn: "无经验", major_cn: ["工学全类"],
        contents: "面向医疗行业客户开展市场支持", start_time: "2099-01-01", end_time: "2099-12-31", district_list: [{ area_cn: "北京" }]
      } : null;
      return response({ code: 200, data: { total: job ? 1 : 0, list: job ? [job] : [] } }, String(url));
    }
  });
  assert.equal(result.leads.length, 1);
  assert.equal(result.leads[0].professionalEligibility.basis, "broad-engineering");
});

test("国聘采集器排除民企，即使岗位专业与工作内容相关", async () => {
  const result = await collectIGuopinDiscovery({
    city: "北京",
    fetchImpl: async (url, init = {}) => {
      const keyword = JSON.parse(init.body).search.keyword;
      const job = keyword === "医疗器械" ? {
        job_id: "iguopin-private", status: 1, job_name: "医疗器械研发工程师", company_name: "示例民企",
        company_info: { nature_cn: "民营企业" }, nature_cn: "校招", education_cn: "硕士", experience_cn: "无经验", major_cn: ["生物医学工程"],
        contents: "医疗器械研发", start_time: "2099-01-01", end_time: "2099-12-31", district_list: [{ area_cn: "北京" }]
      } : null;
      return response({ code: 200, data: { total: job ? 1 : 0, list: job ? [job] : [] } }, String(url));
    }
  });
  assert.equal(result.leads.length, 0);
  assert.equal(result.detailOutcomes["employer-nature-mismatch"], 1);
});

test("国家大学生就业服务平台按专业资格保留岗位并继续排除民企", async () => {
  const listRequests = [];
  const result = await collectNCSSDiscovery({
    city: "北京",
    fetchImpl: async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith("/jobslist/ajax/")) {
        listRequests.push(parsed);
        assert.equal(parsed.searchParams.get("areaCode"), "110100");
        assert.ok(parsed.searchParams.get("jobName"));
        const keyword = parsed.searchParams.get("jobName");
        const list = keyword === "医疗器械" ? [
          { jobId: "ncss-good", jobName: "医疗器械研发工程师", recName: "示例国企", recProperty: "国有企业", degreeName: "硕士及以上", major: "生物医学工程", areaCodeName: "北京市", publishDate: Date.UTC(2099, 0, 1) },
          { jobId: "ncss-ai", jobName: "人工智能工程师", recName: "示例国企", recProperty: "国有企业", degreeName: "硕士", major: "生物医学工程", areaCodeName: "北京市", publishDate: Date.UTC(2099, 0, 1) },
          { jobId: "ncss-private", jobName: "医疗器械研发工程师", recName: "示例民企", recProperty: "民营企业", degreeName: "硕士", major: "生物医学工程", areaCodeName: "北京市", publishDate: Date.UTC(2099, 0, 1) }
        ] : [];
        return response({ flag: true, data: { list, pagenation: { count: list.length, total: 1, limit: 20, offset: 1 } } }, String(url));
      }
      if (parsed.pathname.endsWith("/ncss-good/detail.html")) return response(undefined, String(url), { text: "<title>医疗器械研发工程师-国家大学生就业服务平台</title><div>面向应届毕业生的医疗器械研发</div>" });
      if (parsed.pathname.endsWith("/ncss-ai/detail.html")) return response(undefined, String(url), { text: "<title>人工智能工程师-国家大学生就业服务平台</title><div>通用大模型训练</div>" });
      throw new Error(`unexpected request: ${url}`);
    }
  });
  assert.equal(result.nativeFilterQueries, 11);
  assert.equal(result.deduplicatedCandidates, 3);
  assert.equal(result.detailsChecked, 2);
  assert.equal(result.leads.length, 1);
  assert.ok(result.leads.some((lead) => lead.id === "ncss-good"));
  assert.ok(!result.leads.some((lead) => lead.id === "ncss-ai"));
  assert.equal(result.detailOutcomes["pure-computing-role-mismatch"], 1);
  assert.equal(result.detailOutcomes["employer-nature-mismatch"], 1);
  assert.equal(listRequests.length, 11);
});
