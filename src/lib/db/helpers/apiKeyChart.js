// Shapes per-key usage buckets into chart series for the usage dashboard.
// Raw API keys never leave this module: a series is identified by the key's
// registered id or its masked form, and only name/masked/group are exposed.

export const LOCAL_KEY = "local-no-key";
export const OTHER_SERIES_ID = "other";
const METRICS = ["tokens", "requests", "cost"];

const zeros = (n) => new Array(n).fill(0);
const sum = (arr) => arr.reduce((a, v) => a + v, 0);

export function newKeyBuckets(bucketCount) {
  return { tokens: zeros(bucketCount), requests: zeros(bucketCount), cost: zeros(bucketCount) };
}

/**
 * @param {Map<string, {tokens:number[], requests:number[], cost:number[]}>} perKey raw key (or LOCAL_KEY) → buckets
 * @param {string[]} labels bucket labels
 * @param {(rawKey: string) => {id?: string, name?: string, groupName?: string}|null} resolveKey
 * @param {(rawKey: string) => string|null} maskKey
 * @param {number} topN keys kept as their own series; the rest fold into "Other"
 */
export function buildApiKeySeries(perKey, labels, resolveKey, maskKey, topN = 5) {
  const bucketCount = labels.length;
  const all = [];
  for (const [rawKey, buckets] of perKey) {
    const totals = { tokens: sum(buckets.tokens), requests: sum(buckets.requests), cost: sum(buckets.cost) };
    if (totals.requests === 0) continue;
    const isLocal = rawKey === LOCAL_KEY;
    const info = isLocal ? null : resolveKey(rawKey);
    const masked = isLocal ? null : maskKey(rawKey);
    all.push({
      id: isLocal ? LOCAL_KEY : (info?.id || masked),
      name: isLocal ? "Local (No API Key)" : (info?.name || masked),
      masked,
      group: info?.groupName || null,
      totals,
      tokens: buckets.tokens, requests: buckets.requests, cost: buckets.cost,
    });
  }

  // Rank once (tokens, then requests) so a key keeps its slot whichever metric is shown.
  all.sort((a, b) => b.totals.tokens - a.totals.tokens || b.totals.requests - a.totals.requests);

  const series = all.slice(0, topN);
  const rest = all.slice(topN);
  if (rest.length) {
    const other = {
      id: OTHER_SERIES_ID, name: `Other (${rest.length} keys)`, masked: null, group: null, isOther: true,
      totals: { tokens: 0, requests: 0, cost: 0 }, ...newKeyBuckets(bucketCount),
    };
    for (const s of rest) {
      for (const m of METRICS) {
        other.totals[m] += s.totals[m];
        for (let i = 0; i < bucketCount; i++) other[m][i] += s[m][i];
      }
    }
    series.push(other);
  }

  return { labels, series, keyCount: all.length };
}
