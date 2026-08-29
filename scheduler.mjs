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

export function createScheduleController({ db, syncController, timersEnabled = true, now = () => new Date(), collisionRetryMs = 60_000 }) {
  let timer = null;
  let catchupTimer = null;
  let catchupQueued = false;
  let stopped = false;
  // A timer may wake a fraction early on a busy host. Remember the schedule
  // instant we already dispatched so re-arming cannot fire that same slot a
  // second time before the clock crosses the exact millisecond boundary.
  let lastDispatchedScheduleMs = 0;

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function clearCatchupTimer() {
    if (catchupTimer) clearTimeout(catchupTimer);
    catchupTimer = null;
  }

  function current() {
    const schedule = getUpdateSchedule(db);
    let next = nextDailyRun(schedule, now());
    if (next && next.getTime() <= lastDispatchedScheduleMs) {
      next = nextDailyRun(schedule, new Date(lastDispatchedScheduleMs + 1));
    }
    return { ...schedule, nextRunAt: next?.toISOString() ?? null, catchupQueued };
  }

  function queueCatchup() {
    catchupQueued = true;
    if (stopped || !timersEnabled || catchupTimer) return;
    catchupTimer = setTimeout(() => {
      catchupTimer = null;
      if (stopped || !catchupQueued) return;
      const result = syncController.start("schedule-catchup");
      if (result?.alreadyRunning) queueCatchup();
      else catchupQueued = false;
    }, Math.max(1, collisionRetryMs));
    catchupTimer.unref?.();
  }

  function arm() {
    clearTimer();
    const schedule = current();
    if (!schedule.enabled) {
      clearCatchupTimer();
      catchupQueued = false;
      return { ...schedule, catchupQueued: false };
    }
    if (stopped || !timersEnabled || !schedule.nextRunAt) return schedule;
    const delay = Math.min(Math.max(new Date(schedule.nextRunAt).getTime() - now().getTime(), 1), MAX_TIMEOUT_MS);
    const scheduledForMs = new Date(schedule.nextRunAt).getTime();
    timer = setTimeout(() => {
      timer = null;
      lastDispatchedScheduleMs = Math.max(lastDispatchedScheduleMs, scheduledForMs);
      const triggeredAt = now().toISOString();
      markScheduleTriggered(db, triggeredAt);
      const result = syncController.start("schedule");
      if (result?.alreadyRunning) queueCatchup();
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
      clearCatchupTimer();
      catchupQueued = false;
    },
  };
}
