const SENSITIVE_KEY = /(?:authorization|cookie|password|passwd|secret|session|token|api[-_]?key|signature|sign)$/i;
const SENSITIVE_QUERY_KEY = /(?:authorization|cookie|password|passwd|secret|session|token|api[-_]?key|signature|sign)/i;

function redactUrl(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return value;
    url.username = url.username ? "[redacted]" : "";
    url.password = url.password ? "[redacted]" : "";
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.set(key, "[redacted]");
    }
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

export function sanitizeDiagnosticText(value, { maximumLength = 4_000 } = {}) {
  const text = String(value ?? "")
    .replace(/\b(authorization|cookie|password|passwd|secret|session|token|api[-_]?key)\b\s*[:=]\s*([^\s,;]+)/gi, "$1=[redacted]")
    .replace(/https?:\/\/[^\s"'<>]+/g, (url) => redactUrl(url));
  return text.length > maximumLength ? `…${text.slice(-maximumLength)}` : text;
}

export function sanitizeDiagnosticValue(value, { key = "", depth = 0 } = {}) {
  if (SENSITIVE_KEY.test(key)) return "[redacted]";
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return sanitizeDiagnosticText(value, { maximumLength: 2_000 });
  if (depth >= 5) return "[depth-limited]";
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map((item) => sanitizeDiagnosticValue(item, { depth: depth + 1 }));
    if (value.length > items.length) items.push(`[${value.length - items.length} more items]`);
    return items;
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 60)
      .map(([childKey, child]) => [childKey, sanitizeDiagnosticValue(child, { key: childKey, depth: depth + 1 })]));
  }
  return sanitizeDiagnosticText(value);
}

export function processDiagnostics(result) {
  return sanitizeDiagnosticValue({
    exitCode: result.code,
    durationMs: result.durationMs,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    stdoutTail: result.stdout?.trim() || null,
    stderrTail: result.stderr?.trim() || null,
  });
}

export function sourceDiagnostics(check) {
  const performance = check.performance ?? null;
  const logicalRequests = Number(performance?.logicalRequests || 0);
  const actualAttempts = Number(performance?.actualAttempts || 0);
  const sharedCacheHits = Number(performance?.sharedCacheHits || 0);
  return sanitizeDiagnosticValue({
    status: check.status ?? null,
    attempts: check.attempts ?? null,
    checkedAt: check.checkedAt ?? null,
    collectionMetrics: check.collectionMetrics ?? null,
    performance: performance ? {
      ...performance,
      averageLogicalRequestMs: logicalRequests ? Math.round(Number(performance.requestDurationMs || 0) / logicalRequests) : 0,
      cacheHitRate: logicalRequests ? Number((sharedCacheHits / logicalRequests).toFixed(4)) : 0,
      attemptReuseRate: logicalRequests ? Number(((logicalRequests - actualAttempts) / logicalRequests).toFixed(4)) : 0,
    } : null,
    note: check.note ?? null,
    accessEvidence: check.accessEvidence ?? null,
  });
}

export function collectorPerformanceDiagnostics(records = []) {
  const normalized = records.map((record) => ({
    sourceId: record.sourceId,
    durationMs: Number(record.durationMs || 0),
    logicalRequests: Number(record.logicalRequests || 0),
    actualAttempts: Number(record.actualAttempts || 0),
    sharedCacheHits: Number(record.sharedCacheHits || 0),
    persistentCacheHits: Number(record.persistentCacheHits || 0),
    requestDurationMs: Number(record.requestDurationMs || 0),
  })).sort((left, right) => right.durationMs - left.durationMs);
  const total = (field) => normalized.reduce((sum, item) => sum + item[field], 0);
  return {
    collectorCount: normalized.length,
    totals: {
      logicalRequests: total("logicalRequests"),
      actualAttempts: total("actualAttempts"),
      sharedCacheHits: total("sharedCacheHits"),
      persistentCacheHits: total("persistentCacheHits"),
      cumulativeRequestDurationMs: total("requestDurationMs"),
    },
    collectors: normalized,
  };
}
