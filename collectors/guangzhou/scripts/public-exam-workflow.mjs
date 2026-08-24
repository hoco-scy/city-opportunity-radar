/**
 * Bridges read-only public-exam collectors into the anonymous review-log
 * workflow. It never reads personal profile data and never publishes a public
 * exam job: a separate private eligibility stage is required for that.
 */
import { createHash } from "node:crypto";
import { collectPublicExam } from "./collect-public-exams.mjs";

const SUPPORTED = new Set([
  "national-civil", "beijing-civil", "shanghai-civil", "guangzhou-civil", "shenzhen-civil",
  "beijing-selection-program", "shanghai-selection-program", "guangzhou-selection-program", "shenzhen-selection-program"
]);
const CAMPAIGN_CATEGORIES = new Set(["position-table", "recruitment-announcement", "supplementary-recruitment", "selection-program"]);
const PRE_ANNOUNCEMENT_PATTERN = /(预公告|预报名|即将(?:启动|开始)|拟于.{0,20}(?:启动|报名)|招录计划(?:公布|发布)|敬请关注)/;

function reviewId(sourceId, notice) {
  return `review-${sourceId}-${createHash("sha256").update(notice.id).digest("hex").slice(0, 16)}`;
}

function trackFor(notice) {
  return notice.category === "selection-program" ? "选调优培" : "考公";
}

function positionRowCount(positionTables) {
  return (positionTables?.tables || [])
    .flatMap((table) => table.files)
    .flatMap((file) => file.sheets)
    .reduce((count, sheet) => count + sheet.cityFilteredRows.length, 0);
}

export function campaignNotices(result) {
  return result.notices.filter((notice) => CAMPAIGN_CATEGORIES.has(notice.category));
}

function activeCampaignNotices(result) {
  // A missing deadline is not evidence that a campaign remains open. The one
  // exception is an explicit official pre-announcement: it is retained as a
  // deferred announcement, never promoted to a position or an open deadline.
  return campaignNotices(result).filter((notice) =>
    notice.lifecycle?.status === "open-or-upcoming" || (notice.lifecycle?.status === "unknown" && PRE_ANNOUNCEMENT_PATTERN.test(notice.title || ""))
  );
}

export function publicExamReview(source, notice) {
  const lifecycle = notice.lifecycle || { status: "unknown" };
  const preAnnouncement = lifecycle.status === "unknown" && PRE_ANNOUNCEMENT_PATTERN.test(notice.title || "");
  const reason = preAnnouncement
    ? "官方已发布预公告，尚未给出可用于逐岗判断的完整报名期限或职位表；保留追踪，不能当作可报岗位。"
    : lifecycle.status === "unknown"
      ? "官方公告已采集，但报名截止时间或完整资格字段无法由公开文本可靠结构化，需继续核验。"
    : "官方公告仍处于可关注周期；在使用私有资格档案逐项核对前，不得发布为确认可报岗位。";
  return {
    id: reviewId(source.id, notice),
    scope: "official-announcement",
    track: trackFor(notice),
    organization: source.organization,
    title: notice.title,
    officialPublishedAt: notice.publishedAt || "官方未注明",
    headcount: "公告级待核验",
    deadline: lifecycle.deadline || (preAnnouncement ? "预公告：报名期限待官方公布" : "官方未注明"),
    decision: "deferred",
    reasonCode: preAnnouncement ? "official-preannouncement-position-table-pending" : lifecycle.status === "unknown" ? "application-window-or-eligibility-unknown" : "private-eligibility-check-required",
    reason,
    verificationNote: "已通过官方公告入口、详情与可公开附件完成脚本采集；本记录不含任何个人资格字段。",
    fallback: "等待官方职位表/报名窗口信息完整，或在私有资格流程逐项完成硬条件校验后再决定是否拆分并发布具体岗位。",
    sourceId: source.id,
    officialUrl: notice.officialUrl
  };
}

function accessEvidence(source, result) {
  const collectionEntryUrl = source.collectionEntryUrl || source.entryUrl;
  const collectionHost = new URL(collectionEntryUrl).hostname;
  const finalUrl = result.pagesVisited.find((url) => {
    try {
      const host = new URL(url).hostname;
      return host === collectionHost || host.endsWith(`.${collectionHost}`);
    } catch { return false; }
  }) || collectionEntryUrl;
  return [{
    requestedUrl: collectionEntryUrl,
    finalUrl,
    outcome: "official-page",
    recipe: result.collectionRoute || "官方公开公告采集器已完成列表、详情与附件路径处理。"
  }];
}

export async function collectPublicExamWorkflowSources({ registry, recipes, fetchImpl = fetch } = {}) {
  const recipeBySource = new Map(recipes.recipes.map((recipe) => [recipe.sourceId, recipe]));
  const sources = registry.sources.filter((source) => SUPPORTED.has(source.id) && recipeBySource.get(source.id)?.collection?.primary === "script");
  const outcomes = [];
  for (const source of sources) {
    try {
      let result = await collectPublicExam({ sourceId: source.id, fetchImpl });
      const candidates = activeCampaignNotices(result);
      if (candidates.some((notice) => notice.lifecycle?.status === "open-or-upcoming")) {
        result = await collectPublicExam({ sourceId: source.id, fetchImpl, parseTables: true });
      }
      const currentCandidates = activeCampaignNotices(result);
      const undatedCampaigns = campaignNotices(result).filter((notice) => notice.lifecycle?.status === "unknown");
      const reviews = currentCandidates.map((notice) => publicExamReview(source, notice));
      const status = result.status === "completed-partial"
        ? "accessible-incomplete"
        : reviews.length ? "checked-deferred" : "checked-no-active-campaign";
      const positionRows = positionRowCount(result.positionTables);
      outcomes.push({
        sourceId: source.id,
        result,
        reviews,
        positionRows,
        sourceCheck: {
          sourceId: source.id,
          status,
          attempts: Math.max(1, result.officialEntries.length),
          note: status === "checked-no-active-campaign"
            ? `官方公告、详情和可见附件已完成脚本检查；本轮未发现报名截止日未过且可进入资格判断的公务员/选调公告${undatedCampaigns.length ? `；另有 ${undatedCampaigns.length} 条缺少可解析报名期限的历史/归档公告，未作为在招处理` : ""}。`
            : status === "checked-deferred"
              ? `已采集 ${currentCandidates.length} 条仍需处理的官方公告；尚未使用私有资格档案完成逐项硬条件判断，因此未发布具体岗位。`
              : "官方入口可访问，但公告详情、附件或职位表解析未完成；不据此判断无岗位。",
          collectionMetrics: {
            state: status === "accessible-incomplete" ? "not-completed" : "completed",
            collected: status === "accessible-incomplete" ? null : result.noticeCount,
            afterFilter: status === "accessible-incomplete" ? null : currentCandidates.length,
            filterDescription: status === "accessible-incomplete"
              ? "公告入口可访问，但详情、附件或职位表未完整解析，不能把结果理解为 0 条。"
              : "官方公告与附件 → 仍在有效期内、可继续资格判断的公告",
          },
          accessEvidence: accessEvidence(source, result)
        }
      });
    } catch (error) {
      outcomes.push({
        sourceId: source.id,
        result: undefined,
        reviews: [],
        positionRows: 0,
        sourceCheck: {
          sourceId: source.id,
          status: "temporarily-unavailable",
          attempts: Math.max(3, source.alternateEntryUrls?.length + 1 || 1),
          note: "登记的官方采集路径本轮未能完成；不据此判断无公告。",
          collectionMetrics: {
            state: "unavailable",
            collected: null,
            afterFilter: null,
            filterDescription: "官方采集路径本轮不可用，未生成可比较的候选数量。",
          },
          accessEvidence: [source.collectionEntryUrl || source.entryUrl, ...(source.alternateEntryUrls || [])].map((requestedUrl) => ({
            requestedUrl,
            outcome: "network-error",
            recipe: error.message
          }))
        }
      });
    }
  }
  return outcomes;
}

export function summarizePublicExamOutcomes(outcomes) {
  return outcomes.reduce((summary, outcome) => ({
    sources: summary.sources + 1,
    notices: summary.notices + (outcome.result?.noticeCount || 0),
    positionRows: summary.positionRows + outcome.positionRows,
    deferred: summary.deferred + outcome.reviews.length,
    incomplete: summary.incomplete + (outcome.sourceCheck.status === "accessible-incomplete" || outcome.sourceCheck.status === "temporarily-unavailable" ? 1 : 0)
  }), { sources: 0, notices: 0, positionRows: 0, deferred: 0, incomplete: 0 });
}
