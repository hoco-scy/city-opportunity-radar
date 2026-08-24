/**
 * Shared read-only collection transport.
 *
 * It deliberately does not bypass login, CAPTCHA or WAF controls.  Instead it
 * spaces requests per host, retries transient failures, honours Retry-After,
 * and opens a short circuit when a site asks automated clients to stop.
 */

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
  const delay = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(value) - now();
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

export function createCollectionFetch({
  fetchImpl = globalThis.fetch,
  maxAttempts = 3,
  timeoutMs = 30_000,
  minHostIntervalMs = 800,
  backoffMs = [0, 1_500, 5_000],
  maxRetryAfterMs = 300_000,
  circuitCooldownMs = 300_000,
  transientFailureThreshold = 2,
  random = Math.random,
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("采集请求缺少 fetch 实现");
  const hosts = new Map();
  const counters = { requests: 0, attempts: 0, retries: 0, throttledWaits: 0, rateLimited: 0, blocked: 0, circuitsOpened: 0 };

  function hostState(host) {
    if (!hosts.has(host)) hosts.set(host, { tail: Promise.resolve(), lastStartedAt: 0, openUntil: 0, consecutiveFailures: 0, reason: null });
    return hosts.get(host);
  }

  async function reserve(state) {
    let release;
    const previous = state.tail;
    state.tail = new Promise((resolve) => { release = resolve; });
    await previous;
    const wait = Math.max(0, state.lastStartedAt + minHostIntervalMs - Date.now());
    if (wait) {
      counters.throttledWaits += 1;
      await sleep(wait);
    }
    state.lastStartedAt = Date.now();
    return release;
  }

  function openCircuit(state, host, kind) {
    state.openUntil = Date.now() + circuitCooldownMs;
    state.reason = kind;
    counters.circuitsOpened += 1;
    return new CollectionTransportError(`${host} 已触发${kind === "blocked" ? "反爬/访问控制" : "连续瞬时故障"}，本轮停止继续请求该域名。`, {
      kind: "circuit-open", host, retryAt: new Date(state.openUntil).toISOString(), circuitReason: kind
    });
  }

  async function collectionFetch(input, init = {}) {
    const host = normalizedHost(input);
    const state = hostState(host);
    const method = String(init.method || "GET").toUpperCase();
    const attemptsAllowed = ["GET", "HEAD", "POST"].includes(method) ? Math.max(1, maxAttempts) : 1;
    counters.requests += 1;
    let lastError;

    for (let attempt = 1; attempt <= attemptsAllowed; attempt += 1) {
      if (state.openUntil > Date.now()) {
        throw new CollectionTransportError(`${host} 仍处于访问冷却期。`, {
          kind: "circuit-open", host, attempts: attempt - 1, retryAt: new Date(state.openUntil).toISOString(), circuitReason: state.reason
        });
      }
      if (attempt > 1) {
        counters.retries += 1;
        const base = Number(backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] || 0);
        const jittered = Math.round(base * (0.85 + random() * 0.3));
        if (jittered) await sleep(jittered);
      }

      const release = await reserve(state);
      try {
        counters.attempts += 1;
        // Collector call sites currently pass one-shot timeout signals.  Each
        // retry needs a fresh timeout, while the full workflow has its own
        // process-level cancellation boundary.
        const { signal: _oneShotSignal, ...requestInit } = init;
        const response = await fetchImpl(input, { ...requestInit, signal: AbortSignal.timeout(timeoutMs) });
        if (await looksBlocked(response)) {
          counters.blocked += 1;
          state.consecutiveFailures += 1;
          throw openCircuit(state, host, "blocked");
        }
        if (!RETRYABLE_STATUS.has(Number(response?.status))) {
          state.consecutiveFailures = 0;
          state.reason = null;
          return response;
        }
        if (Number(response.status) === 429) counters.rateLimited += 1;
        lastError = new CollectionTransportError(`${host} 返回可重试的 HTTP ${response.status}。`, {
          kind: Number(response.status) === 429 ? "rate-limited" : "transient-http", host, attempts: attempt
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
          host, attempts: attempt, cause: error
        });
        if (attempt < attemptsAllowed) continue;
      } finally {
        release();
      }
    }

    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= transientFailureThreshold) throw openCircuit(state, host, "transient");
    throw lastError;
  }

  collectionFetch.stats = () => ({
    ...counters,
    hosts: [...hosts.entries()].map(([host, state]) => ({
      host,
      circuit: state.openUntil > Date.now() ? "open" : "closed",
      retryAt: state.openUntil > Date.now() ? new Date(state.openUntil).toISOString() : null,
      reason: state.reason
    }))
  });
  collectionFetch.isResilientCollectionFetch = true;
  return collectionFetch;
}
