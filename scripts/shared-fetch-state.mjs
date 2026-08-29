import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CACHE_VERSION = 1;
const DEFAULT_LOCK_STALE_MS = 10 * 60_000;
const DEFAULT_MAX_CACHE_BODY_BYTES = 24 * 1024 * 1024;
const DEFAULT_PERSISTENT_ROLLING_TTL_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_PERSISTENT_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function atomicWrite(path, value) {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, value);
  await rename(temporaryPath, path);
}

async function acquireDirectoryLock(path, { staleMs, sleep = delay, onWait = () => {} } = {}) {
  const startedAt = Date.now();
  let waited = false;
  for (;;) {
    try {
      await mkdir(path);
      if (waited) onWait(Date.now() - startedAt);
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await rmdir(path).catch(() => {});
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      waited = true;
      try {
        const lockStat = await stat(path);
        if (Date.now() - lockStat.mtimeMs > staleMs) {
          const stalePath = `${path}.stale.${process.pid}.${randomUUID()}`;
          await rename(path, stalePath);
          await rm(stalePath, { recursive: true, force: true });
          continue;
        }
      } catch (lockError) {
        if (!["ENOENT", "EEXIST"].includes(lockError?.code)) throw lockError;
      }
      await sleep(25 + Math.floor(Math.random() * 25));
    }
  }
}

function normalizedHeaders(headers) {
  try {
    return [...new Headers(headers || {}).entries()].sort(([left], [right]) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function bodyFingerprint(body) {
  if (body == null) return "";
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("base64");
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("base64");
  return null;
}

function requestCacheKey(input, init) {
  if (init.radarCache === false) return null;
  const method = String(init.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (!["GET", "HEAD", "POST"].includes(method)) return null;
  const explicitKey = init.radarCacheKey;
  if (explicitKey) return hash(`${method}\nexplicit\n${explicitKey}`);
  const body = bodyFingerprint(init.body);
  if (body == null) return null;
  const url = input instanceof Request ? input.url : String(input);
  return hash(JSON.stringify({ method, url, headers: normalizedHeaders(init.headers), body }));
}

function responseFromSnapshot(metadata, body, { persistent = false } = {}) {
  const response = new Response(metadata.method === "HEAD" ? null : body, {
    status: metadata.status,
    statusText: metadata.statusText,
    headers: metadata.headers,
  });
  try {
    Object.defineProperty(response, "url", { value: metadata.url || "", configurable: true });
    Object.defineProperty(response, "collectionAttempts", { value: 0, configurable: true });
    Object.defineProperty(response, "radarSharedCacheHit", { value: true, configurable: true });
    if (persistent) Object.defineProperty(response, "radarPersistentCacheHit", { value: true, configurable: true });
  } catch {
    // Node's built-in Response is extensible, but a future implementation may not be.
  }
  return response;
}

export function createSharedFetchCoordinator({
  directory,
  persistentDirectory = null,
  minHostIntervalMs = 800,
  lockStaleMs = DEFAULT_LOCK_STALE_MS,
  maxCacheBodyBytes = DEFAULT_MAX_CACHE_BODY_BYTES,
  sleep = delay,
} = {}) {
  if (!directory) return null;
  const responseDirectory = join(directory, "responses");
  const persistentResponseDirectory = persistentDirectory ? join(persistentDirectory, "responses") : null;
  const requestLockDirectory = join(directory, "request-locks");
  const hostLockDirectory = join(directory, "host-locks");
  const hostTimeDirectory = join(directory, "host-times");
  const circuitDirectory = join(directory, "circuits");
  const ready = Promise.all([
    responseDirectory,
    requestLockDirectory,
    hostLockDirectory,
    hostTimeDirectory,
    circuitDirectory,
    ...(persistentResponseDirectory ? [persistentResponseDirectory] : []),
  ].map((path) => mkdir(path, { recursive: true })));

  async function cachedResponse(cacheKey, { persistent = false, ttlMs = null, maxAgeMs = null } = {}) {
    const targetDirectory = persistent && persistentResponseDirectory ? persistentResponseDirectory : responseDirectory;
    try {
      const [metadataText, body] = await Promise.all([
        readFile(join(targetDirectory, `${cacheKey}.json`), "utf8"),
        readFile(join(targetDirectory, `${cacheKey}.body`)),
      ]);
      const metadata = JSON.parse(metadataText);
      if (metadata.version !== CACHE_VERSION) return null;
      const now = Date.now();
      const storedAt = Date.parse(metadata.storedAt);
      const lastConfirmedAt = Date.parse(metadata.lastConfirmedAt || metadata.storedAt);
      const exceedsRollingTtl = persistent && Number.isFinite(ttlMs) && ttlMs > 0 && now - lastConfirmedAt > ttlMs;
      const exceedsHardAge = persistent && Number.isFinite(maxAgeMs) && maxAgeMs > 0 && now - storedAt > maxAgeMs;
      if (exceedsRollingTtl || exceedsHardAge) {
        await Promise.all([
          rm(join(targetDirectory, `${cacheKey}.json`), { force: true }),
          rm(join(targetDirectory, `${cacheKey}.body`), { force: true }),
        ]);
        return null;
      }
      // A persistent request is only made after the collector has read the
      // current live list and recomputed the same detail fingerprint.  Seeing
      // that unchanged fingerprint renews the rolling lease, while storedAt
      // remains fixed so maxAgeMs still forces periodic origin revalidation.
      if (persistent) {
        metadata.lastConfirmedAt = new Date(now).toISOString();
        await atomicWrite(join(targetDirectory, `${cacheKey}.json`), JSON.stringify(metadata));
      }
      return responseFromSnapshot(metadata, body, { persistent });
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async function storeResponse(cacheKey, method, response, { persistent = false } = {}) {
    if (!response || typeof response.clone !== "function") return false;
    if (persistent && !response.ok) return false;
    const targetDirectory = persistent && persistentResponseDirectory ? persistentResponseDirectory : responseDirectory;
    let body;
    try {
      body = Buffer.from(await response.clone().arrayBuffer());
    } catch {
      return false;
    }
    if (body.byteLength > maxCacheBodyBytes) return false;
    const metadata = {
      version: CACHE_VERSION,
      method,
      status: response.status,
      statusText: response.statusText || "",
      url: response.url || "",
      headers: [...response.headers.entries()],
      storedAt: new Date().toISOString(),
      lastConfirmedAt: new Date().toISOString(),
      bodyBytes: body.byteLength,
    };
    await atomicWrite(join(targetDirectory, `${cacheKey}.body`), body);
    await atomicWrite(join(targetDirectory, `${cacheKey}.json`), JSON.stringify(metadata));
    return true;
  }

  async function withCachedResponse(input, init, execute, callbacks = {}) {
    await ready;
    const cacheKey = requestCacheKey(input, init);
    if (!cacheKey) return execute();
    const persistent = init.radarCacheScope === "persistent" && Boolean(persistentResponseDirectory);
    const ttlMs = persistent ? Number(init.radarCacheTtlMs || 0) || DEFAULT_PERSISTENT_ROLLING_TTL_MS : null;
    const maxAgeMs = persistent ? Number(init.radarCacheMaxAgeMs || 0) || DEFAULT_PERSISTENT_MAX_AGE_MS : null;
    const existing = await cachedResponse(cacheKey, { persistent, ttlMs, maxAgeMs });
    if (existing) {
      callbacks.onHit?.({ persistent });
      return existing;
    }
    callbacks.onMiss?.({ persistent });
    const release = await acquireDirectoryLock(join(requestLockDirectory, `${persistent ? "persistent-" : "run-"}${cacheKey}.lock`), {
      staleMs: lockStaleMs,
      sleep,
      onWait: (milliseconds) => callbacks.onCacheWait?.(milliseconds),
    });
    try {
      const afterWait = await cachedResponse(cacheKey, { persistent, ttlMs, maxAgeMs });
      if (afterWait) {
        callbacks.onHit?.({ persistent });
        return afterWait;
      }
      const response = await execute();
      await storeResponse(cacheKey, String(init.method || "GET").toUpperCase(), response, { persistent });
      return response;
    } finally {
      await release();
    }
  }

  async function reserveHost(host, callbacks = {}) {
    await ready;
    const hostKey = hash(host);
    let lockWaitedMs = 0;
    const release = await acquireDirectoryLock(join(hostLockDirectory, `${hostKey}.lock`), {
      staleMs: lockStaleMs,
      sleep,
      onWait: (milliseconds) => { lockWaitedMs = milliseconds; },
    });
    try {
      let lastStartedAt = 0;
      try {
        lastStartedAt = Number(await readFile(join(hostTimeDirectory, `${hostKey}.txt`), "utf8")) || 0;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const intervalWait = Math.max(0, lastStartedAt + minHostIntervalMs - Date.now());
      if (intervalWait) await sleep(intervalWait);
      await atomicWrite(join(hostTimeDirectory, `${hostKey}.txt`), String(Date.now()));
      const waitedMs = lockWaitedMs + intervalWait;
      if (waitedMs > 0) callbacks.onWait?.(waitedMs);
      return release;
    } catch (error) {
      await release();
      throw error;
    }
  }

  async function activeCircuit(host) {
    await ready;
    try {
      const circuit = JSON.parse(await readFile(join(circuitDirectory, `${hash(host)}.json`), "utf8"));
      return Date.parse(circuit.retryAt) > Date.now() ? circuit : null;
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async function openCircuit(host, reason, retryAt) {
    await ready;
    await atomicWrite(join(circuitDirectory, `${hash(host)}.json`), JSON.stringify({ host, reason, retryAt }));
  }

  return { withCachedResponse, reserveHost, activeCircuit, openCircuit };
}

export async function prunePersistentFetchCache(directory, { maxAgeMs = 30 * 24 * 60 * 60_000 } = {}) {
  if (!directory) return { removedEntries: 0 };
  const responseDirectory = join(directory, "responses");
  let filenames;
  try {
    filenames = await readdir(responseDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") return { removedEntries: 0 };
    throw error;
  }
  let removedEntries = 0;
  for (const filename of filenames.filter((name) => name.endsWith(".json"))) {
    const cacheKey = filename.slice(0, -5);
    try {
      const metadata = JSON.parse(await readFile(join(responseDirectory, filename), "utf8"));
      if (Date.now() - Date.parse(metadata.storedAt) <= maxAgeMs) continue;
    } catch { /* Invalid cache metadata is safe to discard. */ }
    await Promise.all([
      rm(join(responseDirectory, `${cacheKey}.json`), { force: true }),
      rm(join(responseDirectory, `${cacheKey}.body`), { force: true }),
    ]);
    removedEntries += 1;
  }
  return { removedEntries };
}
