/**
 * Shared read-only collection transport.
 *
 * It deliberately does not bypass login, CAPTCHA or WAF controls. Instead it
 * spaces requests per host, retries transient failures, honours Retry-After,
 * and opens a short circuit when a site asks automated clients to stop.
 *
 * When RADAR_SHARED_FETCH_STATE_DIR is set by the four-city runner, all city
 * processes share the same host queue, circuit state and run-local response
 * cache. Identical public requests are fetched once and safely reused.
 */
import { createSharedFetchCoordinator } from "../../../scripts/shared-fetch-state.mjs";

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const BLOCKED_STATUS = new Set([401, 403]);
const BLOCK_PAGE = /(?:captcha|cf-chl|attention required|human verification|security check|EO_Bot_Ssid|__tst_status|访问过于频繁|安全验证|人机验证|请输入验证码|验证码页面|请求过于频繁)/i;

export class CollectionTransportError extends Error {
  constructor(message, { kind = "network", host = null, attempts = 0, retryAt = null, circuitReason = null, cause } = {}) {
    super(message, { cause });
    this.name = "CollectionTransportError";
    this.kind = kind;
    this.host = host;
    this.attempts = attempts;
    this.retryAt = retryAt;
    this.circuitReason = circuitReason;
  }
}

function retryAfterMilliseconds(response, now, maximum) {
  const value = response?.headers?.get?.("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - now();
  return Number.isFinite(delay) ? Math.max(0, Math.min(maximum, delay)) : null;
}

async function looksBlocked(response) {
  if (BLOCKED_STATUS.has(Number(response?.status))) return true;
  const contentType = response?.headers?.get?.("content-type") || "";
  if (!/text\/html|text\/plain/i.test(contentType) || typeof response?.clone !== "function") return false;
  try {
    return BLOCK_PAGE.test((await response.clone().text()).slice(0, 64_000));
  } catch {
    return false;
  }
}

function normalizedHost(input) {
  try { return new URL(input instanceof URL ? input : String(input)).hostname.toLowerCase(); }
  catch { return "invalid-host"; }
}

function recordAttempts(response, attempts, cacheHit = false) {
  try {
    Object.defineProperty(response, "collectionAttempts", { value: attempts, configurable: true });
    if (cacheHit) Object.defineProperty(response, "radarSharedCacheHit", { value: true, configurable: true });
  } catch {
    // A non-extensible Response remains valid; callers conservatively count one attempt.
  }
  return response;
}

export function createCollectionFetch({
  fetchImpl = globalThis.fetch,
  maxAttempts = 3,
  timeoutMs = 30_000,
  minHostIntervalMs = 800,
  backoffMs = [0, 1_500, 5_000],
  maxRetryAfterMs = 300_000,
  circuitCooldownMs = 300_000,
  transientFailureThreshold = 2,
  sharedStateDir = process.env.RADAR_SHARED_FETCH_STATE_DIR || null,
  persistentCacheDir = process.env.RADAR_PERSISTENT_FETCH_CACHE_DIR || null,
  random = Math.random,
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("采集请求缺少 fetch 实现");
  const hosts = new Map();
  const counters = {
    requests: 0,
    attempts: 0,
    retries: 0,
    throttledWaits: 0,
    throttledWaitMs: 0,
    rateLimited: 0,
    blocked: 0,
    circuitsOpened: 0,
    sharedCacheHits: 0,
    sharedCacheMisses: 0,
    sharedCacheWaits: 0,
    sharedCacheWaitMs: 0,
    persistentCacheHits: 0,
    persistentCacheMisses: 0,
  };
  const coordinator = createSharedFetchCoordinator({ directory: sharedStateDir, persistentDirectory: persistentCacheDir, minHostIntervalMs, sleep });

  function hostState(host) {
    if (!hosts.has(host)) hosts.set(host, { tail: Promise.resolve(), pendingReservations: 0, lastStartedAt: 0, openUntil: 0, consecutiveFailures: 0, reason: null });
    return hosts.get(host);
  }

  function recordThrottle(milliseconds) {
    if (!milliseconds) return;
    counters.throttledWaits += 1;
    counters.throttledWaitMs += Math.round(milliseconds);
  }

  async function reserve(state, host) {
    if (coordinator) return coordinator.reserveHost(host, { onWait: recordThrottle });
    let release;
    const previous = state.tail;
    const actuallyQueued = state.pendingReservations > 0;
    state.pendingReservations += 1;
    state.tail = new Promise((resolve) => { release = resolve; });
    const queuedAt = Date.now();
    await previous;
    const queueWait = actuallyQueued ? Date.now() - queuedAt : 0;
    const intervalWait = Math.max(0, state.lastStartedAt + minHostIntervalMs - Date.now());
    if (intervalWait) await sleep(intervalWait);
    recordThrottle(queueWait + intervalWait);
    state.lastStartedAt = Date.now();
    return () => {
      state.pendingReservations = Math.max(0, state.pendingReservations - 1);
      release();
    };
  }

  async function openCircuit(state, host, kind, attempts = 0) {
    state.openUntil = Date.now() + circuitCooldownMs;
    state.reason = kind;
    counters.circuitsOpened += 1;
    const retryAt = new Date(state.openUntil).toISOString();
    await coordinator?.openCircuit(host, kind, retryAt);
    return new CollectionTransportError(`${host} 已触发${kind === "blocked" ? "反爬/访问控制" : "连续瞬时故障"}，本轮停止继续请求该域名。`, {
      kind: "circuit-open", host, attempts, retryAt, circuitReason: kind,
    });
  }

  async function executeNetwork(input, init, host, state) {
    const method = String(init.method || "GET").toUpperCase();
    const attemptsAllowed = ["GET", "HEAD", "POST"].includes(method) ? Math.max(1, maxAttempts) : 1;
    let lastError;

    for (let attempt = 1; attempt <= attemptsAllowed; attempt += 1) {
      const sharedCircuit = await coordinator?.activeCircuit(host);
      if (sharedCircuit) {
        throw new CollectionTransportError(`${host} 仍处于共享访问冷却期。`, {
          kind: "circuit-open", host, attempts: attempt - 1, retryAt: sharedCircuit.retryAt, circuitReason: sharedCircuit.reason,
        });
      }
      if (state.openUntil > Date.now()) {
        throw new CollectionTransportError(`${host} 仍处于访问冷却期。`, {
          kind: "circuit-open", host, attempts: attempt - 1, retryAt: new Date(state.openUntil).toISOString(), circuitReason: state.reason,
        });
      }
      if (attempt > 1) {
        counters.retries += 1;
        const base = Number(backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] || 0);
        const jittered = Math.round(base * (0.85 + random() * 0.3));
        if (jittered) await sleep(jittered);
      }

      const release = await reserve(state, host);
      try {
        const queuedSharedCircuit = await coordinator?.activeCircuit(host);
        if (queuedSharedCircuit || state.openUntil > Date.now()) {
          throw new CollectionTransportError(`${host} 在排队期间进入访问冷却期。`, {
            kind: "circuit-open",
            host,
            attempts: attempt - 1,
            retryAt: queuedSharedCircuit?.retryAt || new Date(state.openUntil).toISOString(),
            circuitReason: queuedSharedCircuit?.reason || state.reason,
          });
        }
        counters.attempts += 1;
        const { signal: _oneShotSignal, radarCacheKey: _cacheKey, radarCache: _cacheEnabled, radarCacheScope: _cacheScope, radarCacheTtlMs: _cacheTtl, radarCacheMaxAgeMs: _cacheMaxAge, ...requestInit } = init;
        const response = await fetchImpl(input, { ...requestInit, signal: AbortSignal.timeout(timeoutMs) });
        if (await looksBlocked(response)) {
          counters.blocked += 1;
          state.consecutiveFailures += 1;
          throw await openCircuit(state, host, "blocked", attempt);
        }
        if (!RETRYABLE_STATUS.has(Number(response?.status))) {
          state.consecutiveFailures = 0;
          state.reason = null;
          return recordAttempts(response, attempt);
        }
        if (Number(response.status) === 429) counters.rateLimited += 1;
        lastError = new CollectionTransportError(`${host} 返回可重试的 HTTP ${response.status}。`, {
          kind: Number(response.status) === 429 ? "rate-limited" : "transient-http", host, attempts: attempt,
        });
        if (attempt < attemptsAllowed) {
          const retryAfter = retryAfterMilliseconds(response, Date.now, maxRetryAfterMs);
          if (retryAfter) await sleep(retryAfter);
          continue;
        }
      } catch (error) {
        if (error?.kind === "circuit-open") throw error;
        lastError = new CollectionTransportError(`${host} 的公开请求在第 ${attempt} 次尝试失败。`, {
          kind: error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : "network",
          host, attempts: attempt, cause: error,
        });
        if (attempt < attemptsAllowed) continue;
      } finally {
        await release();
      }
    }

    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= transientFailureThreshold) throw await openCircuit(state, host, "transient", attemptsAllowed);
    throw lastError;
  }

  async function collectionFetch(input, init = {}) {
    const host = normalizedHost(input);
    const state = hostState(host);
    counters.requests += 1;
    const execute = () => executeNetwork(input, init, host, state);
    if (!coordinator) return execute();
    const response = await coordinator.withCachedResponse(input, init, execute, {
      onHit: ({ persistent } = {}) => {
        counters.sharedCacheHits += 1;
        if (persistent) counters.persistentCacheHits += 1;
      },
      onMiss: ({ persistent } = {}) => {
        counters.sharedCacheMisses += 1;
        if (persistent) counters.persistentCacheMisses += 1;
      },
      onCacheWait: (milliseconds) => {
        counters.sharedCacheWaits += 1;
        counters.sharedCacheWaitMs += Math.round(milliseconds);
      },
    });
    return response.radarSharedCacheHit ? recordAttempts(response, 0, true) : response;
  }

  collectionFetch.stats = () => ({
    ...counters,
    sharedCoordination: Boolean(coordinator),
    hosts: [...hosts.entries()].map(([host, state]) => ({
      host,
      circuit: state.openUntil > Date.now() ? "open" : "closed",
      retryAt: state.openUntil > Date.now() ? new Date(state.openUntil).toISOString() : null,
      reason: state.reason,
    })),
  });
  collectionFetch.isResilientCollectionFetch = true;
  return collectionFetch;
}
