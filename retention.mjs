export const PUBLIC_RETENTION_MONTHS = 6;
export const PUBLIC_RETENTION_TIMEZONE = "Asia/Shanghai";

const publicationDateFields = [
  "publishedAt",
  "published_at",
  "publishDate",
  "publishTime",
  "publicationDate",
  "releasedAt",
  "releaseDate",
  "announcementDate",
  "postedAt",
];

const fallbackDateFields = ["checkedAt", "verifiedAt", "verified_at"];

function calendarParts(date, timeZone = PUBLIC_RETENTION_TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

function dateString(year, month, day) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function validDateString(year, month, day) {
  if (![year, month, day].every(Number.isInteger) || month < 1 || month > 12 || day < 1) return null;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= lastDay ? dateString(year, month, day) : null;
}

export function normalizeRetentionDate(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const { year, month, day } = calendarParts(value);
    return dateString(year, month, day);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    return normalizeRetentionDate(new Date(milliseconds));
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  const match = text.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日|\b)/);
  if (match) return validDateString(Number(match[1]), Number(match[2]), Number(match[3]));
  const timestamp = Date.parse(text);
  return Number.isNaN(timestamp) ? null : normalizeRetentionDate(new Date(timestamp));
}

export function publicRetentionCutoff(now = new Date(), months = PUBLIC_RETENTION_MONTHS) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("保留期限的当前时间无效");
  if (!Number.isInteger(months) || months < 1) throw new Error("保留月份必须是正整数");
  const { year, month, day } = calendarParts(now);
  const targetMonthIndex = year * 12 + month - 1 - months;
  const targetYear = Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12 + 1;
  const targetDay = Math.min(day, new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate());
  return dateString(targetYear, targetMonth, targetDay);
}

export function opportunityRetentionInfo(item, { now = new Date(), months = PUBLIC_RETENTION_MONTHS } = {}) {
  const cutoff = publicRetentionCutoff(now, months);
  for (const field of publicationDateFields) {
    const date = normalizeRetentionDate(item?.[field]);
    if (date) return { keep: date >= cutoff, date, cutoff, basis: field, hasPublicationDate: true };
  }
  for (const field of fallbackDateFields) {
    const date = normalizeRetentionDate(item?.[field]);
    if (date) return { keep: date >= cutoff, date, cutoff, basis: field, hasPublicationDate: false };
  }
  return { keep: false, date: null, cutoff, basis: null, hasPublicationDate: false };
}

export function isOpportunityWithinRetention(item, options) {
  return opportunityRetentionInfo(item, options).keep;
}

export function isDateWithinRetention(value, { now = new Date(), months = PUBLIC_RETENTION_MONTHS } = {}) {
  const date = normalizeRetentionDate(value);
  return Boolean(date && date >= publicRetentionCutoff(now, months));
}
