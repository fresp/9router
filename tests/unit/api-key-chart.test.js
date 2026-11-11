import { describe, it, expect } from "vitest";
import { buildApiKeySeries, newKeyBuckets, LOCAL_KEY, OTHER_SERIES_ID } from "../../src/lib/db/helpers/apiKeyChart.js";

const mask = (k) => k.slice(0, 3) + "***";
const labels = ["a", "b"];

function perKeyOf(entries) {
  const m = new Map();
  for (const [key, tokens, requests = 1] of entries) {
    const b = newKeyBuckets(labels.length);
    b.tokens[0] = tokens;
    b.requests[0] = requests;
    b.cost[1] = tokens / 1000;
    m.set(key, b);
  }
  return m;
}

describe("buildApiKeySeries", () => {
  it("never exposes the raw key", () => {
    const raw = "sk-secret-raw-key-value";
    const out = buildApiKeySeries(perKeyOf([[raw, 10], ["sk-registered-key", 5]]), labels,
      (k) => (k === "sk-registered-key" ? { id: "key-1", name: "CI", groupName: "Team" } : null), mask);
    expect(JSON.stringify(out)).not.toContain(raw);
    expect(JSON.stringify(out)).not.toContain("sk-registered-key");
    expect(out.series[0]).toMatchObject({ id: "sk-***", name: "sk-***", group: null });
    expect(out.series[1]).toMatchObject({ id: "key-1", name: "CI", group: "Team" });
  });

  it("ranks by tokens and folds keys past topN into Other", () => {
    const out = buildApiKeySeries(perKeyOf([["k1", 1], ["k2", 50], ["k3", 20], ["k4", 5]]), labels, () => null, (k) => k, 2);
    expect(out.keyCount).toBe(4);
    expect(out.series.map((s) => s.id)).toEqual(["k2", "k3", OTHER_SERIES_ID]);
    const other = out.series[2];
    expect(other.isOther).toBe(true);
    expect(other.name).toBe("Other (2 keys)");
    expect(other.tokens).toEqual([6, 0]);
    expect(other.totals).toMatchObject({ tokens: 6, requests: 2 });
  });

  it("labels keyless traffic and drops empty keys", () => {
    const perKey = perKeyOf([[LOCAL_KEY, 3]]);
    perKey.set("unused", newKeyBuckets(labels.length));
    const out = buildApiKeySeries(perKey, labels, () => null, mask);
    expect(out.series).toHaveLength(1);
    expect(out.series[0]).toMatchObject({ id: LOCAL_KEY, name: "Local (No API Key)", masked: null });
  });
});
