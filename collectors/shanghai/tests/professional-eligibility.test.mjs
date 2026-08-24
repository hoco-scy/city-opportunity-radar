import test from "node:test";
import assert from "node:assert/strict";
import { evaluateProfessionalEligibility, matchLevelForPriority, rankProfessionalOpportunity, roleIsProfileRelevant } from "../scripts/professional-eligibility.mjs";

test("professional eligibility uses exact major tokens and a biomedical bridge for pure computing roles", () => {
  assert.equal(evaluateProfessionalEligibility("专业要求：生物医学工程").eligible, true);
  assert.equal(evaluateProfessionalEligibility("工学门类、理工类专业均可").eligible, true);
  assert.equal(evaluateProfessionalEligibility("专业不限").eligible, true);
  assert.equal(evaluateProfessionalEligibility("计算机科学与技术、软件工程、人工智能").eligible, false);
  assert.equal(evaluateProfessionalEligibility("计算机类；软件工程类；网络空间安全类").eligible, false);
  assert.equal(evaluateProfessionalEligibility("机械工程、自动化、电子信息技术等相关专业").eligible, false);
  assert.equal(evaluateProfessionalEligibility("保险、IT相关专业；熟练使用需求管理工具").eligible, false);
  assert.equal(evaluateProfessionalEligibility("专业要求：临床医学、超声医学或中医学").eligible, false);
  assert.equal(evaluateProfessionalEligibility("专业要求：护理学、药学或公共卫生").eligible, false);
  const eligible = evaluateProfessionalEligibility("生物医学工程相关专业");
  const genericAiPriority = rankProfessionalOpportunity(eligible, "人工智能工程师（安全方向）");
  const medicalDevicePriority = rankProfessionalOpportunity(eligible, "医疗器械研发工程师");
  assert.equal(matchLevelForPriority(genericAiPriority, eligible), "重点关注");
  assert.equal(matchLevelForPriority(medicalDevicePriority, eligible), "高度匹配");
  assert.ok(medicalDevicePriority > genericAiPriority);
  assert.equal(roleIsProfileRelevant("人工智能工程师（安全方向），开展通用大模型训练"), false);
  assert.equal(roleIsProfileRelevant("医学影像算法工程师，处理医疗设备图像"), true);
});
