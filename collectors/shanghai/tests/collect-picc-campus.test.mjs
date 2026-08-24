import test from "node:test";
import assert from "node:assert/strict";
import { collectPiccCampus } from "../scripts/collect-picc-campus.mjs";

function response(data, url, text) {
  return { ok: true, status: 200, url, json: async () => data, text: async () => text ?? JSON.stringify(data) };
}

test("PICC collector closes filtered pagination and keeps computing roles only with a biomedical bridge", async () => {
  const requests = [];
  const result = await collectPiccCampus({ city: "上海", now: new Date("2026-08-24T01:00:00Z"), fetchImpl: async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).includes("/custom/campus")) return response({}, String(url), 'BSGlobal.PortalId = "20e42367-7ff6-422b-8dd9-92f72842818a";');
    if (String(url).includes("SearchAreasTreeConditions")) return response({ Code: 200, Data: [{ Code: "3100", Name: ["上海市"] }] }, String(url));
    const body = JSON.parse(init.body);
    assert.deepEqual(body.Category, [2]);
    assert.deepEqual(body.LocId, [3100]);
    assert.equal(body.PageIndex, 0);
    return response({ Code: 200, Count: 2, Data: [
      { JobAdId: 1, JobAdName: "人保-医学影像算法工程师-2027届校招(J90001)", Org: "中国人保", Category: "校园招聘", LocNames: ["上海市"], Require: "硕士研究生；生物医学工程相关专业", Duty: "医疗设备医学影像算法研发", PostDate: "2026-08-20", EndTime: "2222-02-02", Status: 1 },
      { JobAdId: 2, JobAdName: "人保-需求管理岗-2027届校招(J90002)", Org: "中国人保", Category: "校园招聘", LocNames: ["上海市"], Require: "硕士研究生；计算机、软件工程相关专业；熟练使用管理工具", Duty: "需求管理", PostDate: "2026-08-20", EndTime: "2222-02-02", Status: 1 }
    ] }, String(url));
  }});
  assert.equal(result.collected, 2);
  assert.equal(result.afterFilter, 1);
  assert.equal(result.jobs[0].title, "医学影像算法工程师");
  assert.equal(result.jobs[0].professionalEligibility.basis, "exact");
  assert.equal(requests.filter((item) => item.url.includes("GetJobAdPageList")).length, 1);
});
