import { getUpdateSchedule, markScheduleTriggered } from "./db.mjs";

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;
const MAX_TIMEOUT_MS = 2_147_000_000;

export function nextDailyRun(schedule, now = new Date()) {
  if (!schedule?.enabled || !Array.isArray(schedule.times) || !schedule.times.length) return null;
  if (schedule.timezone !== "Asia/Shanghai") throw new Error("当前只支持 Asia/Shanghai 时区");
  const localNow = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const year = localNow.getUTCFullYear();
  const month = localNow.getUTCMonth();
  const day = localNow.getUTCDate();
  for (let dayOffset = 0; dayOffset <= 1; dayOffset += 1) {
    for (const time of schedule.times) {
      const [hour, minute] = time.split(":").map(Number);
      const instant = new Date(Date.UTC(year, month, day + dayOffset, hour - 8, minute));
      if (instant.getTime() > now.getTime()) return instant;
    }
  }
  return null;
}

export function createScheduleController({ db, syncController, timersEnabled = true, now = () => new Date() }) {
  let timer = null;
  let stopped = false;

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function current() {
    const schedule = getUpdateSchedule(db);
    const next = nextDailyRun(schedule, now());
    return { ...schedule, nextRunAt: next?.toISOString() ?? null };
  }

  function arm() {
    clearTimer();
    const schedule = current();
    if (stopped || !timersEnabled || !schedule.enabled || !schedule.nextRunAt) return schedule;
    const delay = Math.min(Math.max(new Date(schedule.nextRunAt).getTime() - now().getTime(), 1), MAX_TIMEOUT_MS);
    timer = setTimeout(() => {
      timer = null;
      const triggeredAt = now().toISOString();
      markScheduleTriggered(db, triggeredAt);
      syncController.start("schedule");
      arm();
    }, delay);
    timer.unref?.();
    return schedule;
  }

  return {
    current,
    refresh: arm,
    stop() {
      stopped = true;
      clearTimer();
    },
  };
}
