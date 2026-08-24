import test from "node:test";
import assert from "node:assert/strict";
import { classifyBoeRow } from "../scripts/collect-boe-campus.mjs";
import { classifyCrcRow } from "../scripts/collect-crc-careers.mjs";

const checkedAt = "2026-08-24T10:00:00+08:00";

test("京东方计算岗位需要明确的生物医学交叉场景", () => {
  const result = classifyBoeRow({
    JobAdId: "boe-1", JobAdName: "医学影像算法研发工程师(J90001)", Org: "京东方技术中心",
    LocNames: ["北京市"], Require: "硕士研究生及以上学历，生物医学工程、电子信息等相关专业。",
    Duty: "负责医疗设备医学影像算法研发与产品验证。", Category: "校园招聘", PostDate: "2026-08-20"
  }, "北京", checkedAt);
  assert.equal(result.outcome, "accepted");
  assert.equal(result.job.verification.eligibility, true);
  assert.equal(classifyBoeRow({
    JobAdId: "boe-generic-ai", JobAdName: "人工智能工程师（安全方向）", Org: "京东方技术中心",
    LocNames: ["北京市"], Require: "硕士研究生及以上学历，生物医学工程专业。", Duty: "通用模型安全研发。"
  }, "北京", checkedAt).outcome, "pure-computing-role-mismatch");
});

test("京东方校园分类中的实习岗位不会混入应届岗位", () => {
  assert.equal(classifyBoeRow({
    JobAdId: "boe-2", JobAdName: "【2026实习生】研发实习生(J90002)", LocNames: ["北京市"], Require: "生物医学工程专业"
  }, "北京", checkedAt).outcome, "internship");
});

test("华润校招岗位接受工学门类时保留，即使标题不是医疗岗位", () => {
  const result = classifyCrcRow({
    pubPositionId: "crc-1", typeId: "A02", typeIdDescr: "校园招聘", pubPositionName: "产品研发岗",
    locationDescr: "中国,广东,深圳市", brandName: "华润医药", companyDescr: "华润医药",
    rmEducationalRqmtDescr: "硕士研究生及以上", rmJobRqmt: "工学门类、理工类相关专业均可报名。",
    rmJobDuty: "负责产品与流程研发。", publishDate: "2026-08-20"
  }, "深圳", checkedAt);
  assert.equal(result.outcome, "accepted");
  assert.equal(result.job.professionalEligibility.basis, "broad-engineering");
});

test("华润社招即使专业匹配也不进入应届岗位", () => {
  assert.equal(classifyCrcRow({
    pubPositionId: "crc-2", typeId: "A01", typeIdDescr: "社会招聘", pubPositionName: "医学工程师",
    locationDescr: "中国,北京,北京市", rmJobRqmt: "生物医学工程专业"
  }, "北京", checkedAt).outcome, "non-campus");
});

test("华润公开接口残留的过届校招岗位不会作为当前应届岗位发布", () => {
  assert.equal(classifyCrcRow({
    pubPositionId: "crc-3", typeId: "A02", typeIdDescr: "校园招聘", pubPositionName: "医疗器械管培生",
    locationDescr: "中国,北京,北京市", rmEducationalRqmtDescr: "本科及以上", rmJobRqmt: "2025届毕业生，生物医学工程专业。"
  }, "北京", checkedAt).outcome, "old-cohort");
});
