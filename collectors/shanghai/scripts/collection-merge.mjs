function opportunityKey(item) {
  const normalize = (value) => String(value || "").normalize("NFKC").toLowerCase().replace(/[\s·•—_（）()\-]/g, "");
  const organization = normalize(item.organization);
  const title = normalize(item.exactTitle || item.title);
  return organization && title ? `${organization}::${title}` : `id::${item.sourceId || "unknown"}::${item.id || "unknown"}`;
}

/** Preserve failed-source snapshots, while removing cross-platform and already verified duplicates. */
export function mergeDiscoveryCandidates(previous = [], fresh = [], results = [], verifiedJobs = []) {
  const failed = new Set(results.filter((result) => result?.collectionError).map((result) => result.sourceId));
  const verifiedKeys = new Set(verifiedJobs.map(opportunityKey));
  const merged = [...fresh, ...previous.filter((candidate) => failed.has(candidate.sourceId))]
    .filter((candidate) => !verifiedKeys.has(opportunityKey(candidate)))
    .sort((left, right) => (Number(right.priority) || 0) - (Number(left.priority) || 0));
  const seen = new Set();
  return merged.filter((candidate) => {
    const key = opportunityKey(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function mergeOfficialMonitors(previous = [], fresh = [], results = new Map()) {
  const completed = new Set([...results.entries()]
    .filter(([, result]) => String(result?.status).startsWith("checked-"))
    .map(([sourceId]) => sourceId));
  return [...fresh, ...previous.filter((monitor) => !completed.has(monitor.sourceId))];
}
