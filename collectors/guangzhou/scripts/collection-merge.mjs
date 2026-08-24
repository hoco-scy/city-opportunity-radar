/** Preserve the last successful snapshot for sources that did not complete. */
export function mergeDiscoveryCandidates(previous = [], fresh = [], results = []) {
  const failed = new Set(results.filter((result) => result?.collectionError).map((result) => result.sourceId));
  return [...fresh, ...previous.filter((candidate) => failed.has(candidate.sourceId))];
}

export function mergeOfficialMonitors(previous = [], fresh = [], results = new Map()) {
  const completed = new Set([...results.entries()]
    .filter(([, result]) => String(result?.status).startsWith("checked-"))
    .map(([sourceId]) => sourceId));
  return [...fresh, ...previous.filter((monitor) => !completed.has(monitor.sourceId))];
}
