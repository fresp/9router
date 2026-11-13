// Agentic coding fixtures: each task is a tiny project with failing tests.
// `files` is what the model sees, `solution` is a reference fix used only by `suite.mjs selftest`
// to prove every task is solvable and that the starting state really fails.

const T = (name) => `import test from "node:test";\nimport assert from "node:assert/strict";\n`;

export const CODING_TASKS = [
  {
    id: "paginate",
    files: {
      "paginate.mjs": `// Pages are 1-based. totalPages counts a final partial page.
export function paginate(items, page, size) {
  const start = page * size;
  return { items: items.slice(start, start + size), totalPages: Math.floor(items.length / size) };
}
`,
      "test.mjs": T() + `import { paginate } from "./paginate.mjs";
const ten = [1,2,3,4,5,6,7,8,9,10];
test("first page", () => assert.deepEqual(paginate(ten, 1, 3), { items: [1,2,3], totalPages: 4 }));
test("last partial page", () => assert.deepEqual(paginate(ten, 4, 3), { items: [10], totalPages: 4 }));
test("exact fit", () => assert.deepEqual(paginate(ten, 2, 5), { items: [6,7,8,9,10], totalPages: 2 }));
test("empty", () => assert.deepEqual(paginate([], 1, 5), { items: [], totalPages: 0 }));
`,
    },
    solution: {
      "paginate.mjs": `export function paginate(items, page, size) {
  const start = (page - 1) * size;
  return { items: items.slice(start, start + size), totalPages: Math.ceil(items.length / size) };
}
`,
    },
  },
  {
    id: "retry",
    files: {
      "retry.mjs": `// Calls fn(attempt). On failure waits delay(attempt) and tries again.
// \`retries\` is the number of retries AFTER the first attempt. Throws the last error.
export async function retry(fn, { retries = 3, delay = () => Promise.resolve() } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try { return fn(i); } catch (e) { lastErr = e; await delay(i); }
  }
  throw lastErr;
}
`,
      "test.mjs": T() + `import { retry } from "./retry.mjs";
test("succeeds after two failures", async () => {
  let calls = 0;
  const out = await retry(async () => { calls++; if (calls < 3) throw new Error("no " + calls); return "ok"; }, { retries: 3 });
  assert.equal(out, "ok"); assert.equal(calls, 3);
});
test("throws the last error after retries+1 attempts", async () => {
  let calls = 0;
  await assert.rejects(retry(async () => { calls++; throw new Error("fail " + calls); }, { retries: 2 }), /fail 3/);
  assert.equal(calls, 3);
});
test("delay runs between attempts only", async () => {
  const delays = [];
  await assert.rejects(retry(async () => { throw new Error("x"); }, { retries: 2, delay: async (i) => { delays.push(i); } }));
  assert.deepEqual(delays, [0, 1]);
});
test("sync throw is retried too", async () => {
  let calls = 0;
  const out = await retry(() => { calls++; if (calls === 1) throw new Error("sync"); return 7; }, { retries: 1 });
  assert.equal(out, 7);
});
`,
    },
    solution: {
      "retry.mjs": `export async function retry(fn, { retries = 3, delay = () => Promise.resolve() } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(i); } catch (e) { lastErr = e; if (i < retries) await delay(i); }
  }
  throw lastErr;
}
`,
    },
  },
  {
    id: "deduper",
    files: {
      "deduper.mjs": `// Drops duplicate event ids seen within ttlMs of the FIRST accepted occurrence (fixed window,
// a duplicate does not extend it). An entry expires when now - acceptedAt >= ttlMs.
export class Deduper {
  constructor(ttlMs, now = () => Date.now()) { this.ttlMs = ttlMs; this.now = now; this.seen = new Map(); }
  // true if the event is new and should be processed
  accept(id) {
    const t = this.now();
    if (this.seen.has(id)) return false;
    this.seen.set(id, t);
    return true;
  }
  // number of ids currently inside their window
  size() { return this.seen.size; }
}
`,
      "test.mjs": T() + `import { Deduper } from "./deduper.mjs";
function clock() { let t = 0; const now = () => t; now.set = (v) => { t = v; }; return now; }
test("duplicate inside window is dropped", () => {
  const now = clock(); const d = new Deduper(100, now);
  assert.equal(d.accept("a"), true); now.set(50); assert.equal(d.accept("a"), false);
});
test("accepted again after expiry, boundary inclusive", () => {
  const now = clock(); const d = new Deduper(100, now);
  d.accept("a"); now.set(100); assert.equal(d.accept("a"), true);
});
test("duplicate does not extend the window", () => {
  const now = clock(); const d = new Deduper(100, now);
  d.accept("a"); now.set(60); assert.equal(d.accept("a"), false); now.set(110); assert.equal(d.accept("a"), true);
});
test("size ignores expired ids", () => {
  const now = clock(); const d = new Deduper(100, now);
  d.accept("a"); now.set(40); d.accept("b"); assert.equal(d.size(), 2);
  now.set(120); assert.equal(d.size(), 1); now.set(500); assert.equal(d.size(), 0);
});
`,
    },
    solution: {
      "deduper.mjs": `export class Deduper {
  constructor(ttlMs, now = () => Date.now()) { this.ttlMs = ttlMs; this.now = now; this.seen = new Map(); }
  accept(id) {
    const t = this.now();
    const at = this.seen.get(id);
    if (at !== undefined && t - at < this.ttlMs) return false;
    this.seen.set(id, t);
    return true;
  }
  size() {
    const t = this.now();
    for (const [k, at] of this.seen) if (t - at >= this.ttlMs) this.seen.delete(k);
    return this.seen.size;
  }
}
`,
    },
  },
  {
    id: "lru",
    files: {
      "lru.mjs": `// Least-recently-used cache. Both get() and set() count as use.
export class LRU {
  constructor(cap) { this.cap = cap; this.map = new Map(); }
  get(k) { return this.map.get(k); }
  set(k, v) {
    if (this.map.size >= this.cap) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this.map.set(k, v);
  }
  get size() { return this.map.size; }
}
`,
      "test.mjs": T() + `import { LRU } from "./lru.mjs";
test("get refreshes recency", () => {
  const c = new LRU(2); c.set("a", 1); c.set("b", 2); c.get("a"); c.set("c", 3);
  assert.equal(c.get("b"), undefined); assert.equal(c.get("a"), 1); assert.equal(c.get("c"), 3);
});
test("updating a key does not evict", () => {
  const c = new LRU(2); c.set("a", 1); c.set("b", 2); c.set("a", 10);
  assert.equal(c.size, 2); assert.equal(c.get("b"), 2); assert.equal(c.get("a"), 10);
});
test("update refreshes recency", () => {
  const c = new LRU(2); c.set("a", 1); c.set("b", 2); c.set("a", 10); c.set("c", 3);
  assert.equal(c.get("b"), undefined); assert.equal(c.get("a"), 10);
});
test("missing key does not change order", () => {
  const c = new LRU(2); c.set("a", 1); c.set("b", 2); c.get("zzz"); c.set("c", 3);
  assert.equal(c.get("a"), undefined); assert.equal(c.get("b"), 2);
});
`,
    },
    solution: {
      "lru.mjs": `export class LRU {
  constructor(cap) { this.cap = cap; this.map = new Map(); }
  get(k) {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k); this.map.delete(k); this.map.set(k, v); return v;
  }
  set(k, v) {
    if (this.map.has(k)) this.map.delete(k);
    else if (this.map.size >= this.cap) this.map.delete(this.map.keys().next().value);
    this.map.set(k, v);
  }
  get size() { return this.map.size; }
}
`,
    },
  },
  {
    id: "token-bucket",
    files: {
      "bucket.mjs": `// Token bucket. now() returns milliseconds. Starts full, refills continuously at
// refillPerSec tokens per second and never holds more than capacity.
export class TokenBucket {
  constructor({ capacity, refillPerSec, now }) {
    this.capacity = capacity; this.rate = refillPerSec; this.now = now;
    this.tokens = capacity; this.last = now();
  }
  take(n = 1) {
    const t = this.now();
    this.tokens += (t - this.last) * this.rate;
    this.last = t;
    if (this.tokens >= n) { this.tokens -= n; return true; }
    return false;
  }
}
`,
      "test.mjs": T() + `import { TokenBucket } from "./bucket.mjs";
function clock() { let t = 1000; const now = () => t; now.add = (v) => { t += v; }; return now; }
const drain = (b, n) => { for (let i = 0; i < n; i++) b.take(); };
test("starts full then empties", () => {
  const now = clock(); const b = new TokenBucket({ capacity: 5, refillPerSec: 1, now });
  for (let i = 0; i < 5; i++) assert.equal(b.take(), true);
  assert.equal(b.take(), false);
});
test("refills one token per second", () => {
  const now = clock(); const b = new TokenBucket({ capacity: 5, refillPerSec: 1, now }); drain(b, 5);
  now.add(1000); assert.equal(b.take(), true); assert.equal(b.take(), false);
});
test("partial refill accumulates", () => {
  const now = clock(); const b = new TokenBucket({ capacity: 5, refillPerSec: 1, now }); drain(b, 5);
  now.add(500); assert.equal(b.take(), false); now.add(500); assert.equal(b.take(), true);
});
test("never exceeds capacity", () => {
  const now = clock(); const b = new TokenBucket({ capacity: 5, refillPerSec: 1, now }); drain(b, 5);
  now.add(60000); let ok = 0; for (let i = 0; i < 20; i++) if (b.take()) ok++; assert.equal(ok, 5);
});
test("take(n) is all or nothing", () => {
  const now = clock(); const b = new TokenBucket({ capacity: 5, refillPerSec: 1, now });
  assert.equal(b.take(6), false); assert.equal(b.take(5), true); assert.equal(b.take(1), false);
});
`,
    },
    solution: {
      "bucket.mjs": `export class TokenBucket {
  constructor({ capacity, refillPerSec, now }) {
    this.capacity = capacity; this.rate = refillPerSec; this.now = now;
    this.tokens = capacity; this.last = now();
  }
  take(n = 1) {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
    if (this.tokens >= n) { this.tokens -= n; return true; }
    return false;
  }
}
`,
    },
  },
  {
    id: "csv-line",
    files: {
      "csv.mjs": `// Parse ONE line of CSV into fields. Fields may be wrapped in double quotes; inside quotes a comma
// is literal and "" means one quote character. No trimming.
export function parseLine(line) {
  return line.split(",");
}
`,
      "test.mjs": T() + `import { parseLine } from "./csv.mjs";
test("plain", () => assert.deepEqual(parseLine("a,b,c"), ["a", "b", "c"]));
test("quoted comma", () => assert.deepEqual(parseLine('a,"b,c",d'), ["a", "b,c", "d"]));
test("escaped quotes", () => assert.deepEqual(parseLine('"he said ""hi""",x'), ['he said "hi"', "x"]));
test("empty fields", () => assert.deepEqual(parseLine("a,,c"), ["a", "", "c"]));
test("trailing empty", () => assert.deepEqual(parseLine("a,"), ["a", ""]));
test("quoted empty", () => assert.deepEqual(parseLine('""'), [""]));
test("spaces kept", () => assert.deepEqual(parseLine(' a , "b " '), [" a ", ' "b " ']));
`,
    },
    solution: {
      "csv.mjs": `export function parseLine(line) {
  const out = []; let cur = ""; let i = 0; let quoted = false; let atStart = true;
  while (i < line.length) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i += 2; continue; } quoted = false; i++; continue; }
      cur += ch; i++; continue;
    }
    if (ch === "," ) { out.push(cur); cur = ""; atStart = true; i++; continue; }
    if (ch === '"' && atStart) { quoted = true; atStart = false; i++; continue; }
    cur += ch; atStart = false; i++;
  }
  out.push(cur);
  return out;
}
`,
    },
  },
  {
    id: "contacts",
    files: {
      "phone.mjs": `// Normalise Indonesian numbers to digits starting with 62:
// "0812..." -> "62812...", "+62 812..." -> "62812...", "62812..." stays, bare "812..." -> "62812...".
export function normalizePhone(raw) {
  const digits = raw.replace(/\\D/g, "");
  if (digits.startsWith("0")) return "62" + digits;
  return digits;
}
`,
      "contacts.mjs": `import { normalizePhone } from "./phone.mjs";
// Merge contacts that share a phone number (after normalisation). Keep the first name seen,
// output the normalised phone, and union the tags (unique, sorted). Never mutate the input.
export function mergeContacts(list) {
  const byPhone = new Map();
  for (const c of list) {
    const key = c.phone;
    const cur = byPhone.get(key);
    if (!cur) byPhone.set(key, { name: c.name, phone: key, tags: c.tags });
    else cur.tags.push(...c.tags);
  }
  return [...byPhone.values()];
}
`,
      "test.mjs": T() + `import { normalizePhone } from "./phone.mjs";
import { mergeContacts } from "./contacts.mjs";
test("normalise formats", () => {
  for (const raw of ["0812-3456-789", "+62 812 3456 789", "628123456789", "8123456789"]) assert.equal(normalizePhone(raw), "628123456789");
});
test("merge by normalised phone", () => {
  const input = [
    { name: "Budi", phone: "0812-3456-789", tags: ["vip", "b2b"] },
    { name: "Budi S", phone: "+62 812 3456 789", tags: ["b2b", "jakarta"] },
    { name: "Sari", phone: "0813 0000 111", tags: [] },
    { name: "B.", phone: "628123456789", tags: ["alpha"] },
  ];
  const snapshot = JSON.parse(JSON.stringify(input));
  const out = mergeContacts(input);
  assert.deepEqual(out, [
    { name: "Budi", phone: "628123456789", tags: ["alpha", "b2b", "jakarta", "vip"] },
    { name: "Sari", phone: "628130000111", tags: [] },
  ]);
  assert.deepEqual(input, snapshot);
});
`,
    },
    solution: {
      "phone.mjs": `export function normalizePhone(raw) {
  const digits = raw.replace(/\\D/g, "");
  if (digits.startsWith("62")) return digits;
  if (digits.startsWith("0")) return "62" + digits.slice(1);
  return "62" + digits;
}
`,
      "contacts.mjs": `import { normalizePhone } from "./phone.mjs";
export function mergeContacts(list) {
  const byPhone = new Map();
  for (const c of list) {
    const key = normalizePhone(c.phone);
    const cur = byPhone.get(key);
    if (!cur) byPhone.set(key, { name: c.name, phone: key, tags: new Set(c.tags) });
    else for (const t of c.tags) cur.tags.add(t);
  }
  return [...byPhone.values()].map((c) => ({ ...c, tags: [...c.tags].sort() }));
}
`,
    },
  },
  {
    id: "toposort",
    files: {
      "toposort.mjs": `// graph: { node: [dependencies...] }. Return every node (including ones that appear only as a
// dependency) ordered so dependencies come first. When several nodes are ready, emit them in
// alphabetical order. Throw an Error whose message contains "cycle" if the graph has one.
export function toposort(graph) {
  throw new Error("not implemented");
}
`,
      "test.mjs": T() + `import { toposort } from "./toposort.mjs";
test("linear", () => assert.deepEqual(toposort({ c: ["b"], b: ["a"], a: [] }), ["a", "b", "c"]));
test("alphabetical among ready nodes", () => {
  assert.deepEqual(toposort({ app: ["db", "cache"], db: ["net"], cache: ["net"], net: [], zeta: [], alpha: [] }), ["alpha", "net", "cache", "db", "app", "zeta"]);
});
test("implicit nodes", () => assert.deepEqual(toposort({ b: ["a"], c: ["a", "x"] }), ["a", "b", "x", "c"]));
test("cycle", () => assert.throws(() => toposort({ a: ["b"], b: ["c"], c: ["a"], d: [] }), /cycle/));
test("empty", () => assert.deepEqual(toposort({}), []));
`,
    },
    solution: {
      "toposort.mjs": `export function toposort(graph) {
  const deps = new Map();
  for (const [n, ds] of Object.entries(graph)) {
    if (!deps.has(n)) deps.set(n, new Set());
    for (const d of ds) { deps.get(n).add(d); if (!deps.has(d)) deps.set(d, new Set()); }
  }
  const out = [];
  const done = new Set();
  while (out.length < deps.size) {
    const ready = [...deps.keys()].filter((n) => !done.has(n) && [...deps.get(n)].every((d) => done.has(d))).sort();
    if (!ready.length) throw new Error("cycle detected");
    out.push(ready[0]); done.add(ready[0]);
  }
  return out;
}
`,
    },
  },
  {
    id: "allocate",
    files: {
      "allocate.mjs": `// Split totalCents (integer) across weights. Every share is an integer and the shares sum to
// totalCents: take the floor of each exact share, then hand out the leftover cents one at a time
// to the largest weights first (ties: earlier index first).
export function allocate(totalCents, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => Math.round((totalCents * w) / sum));
}
`,
      "test.mjs": T() + `import { allocate } from "./allocate.mjs";
test("thirds", () => assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]));
test("exact", () => assert.deepEqual(allocate(1000, [50, 30, 20]), [500, 300, 200]));
test("leftover goes to largest weight", () => assert.deepEqual(allocate(5, [3, 7]), [1, 4]));
test("ties by index", () => assert.deepEqual(allocate(10, [1, 1, 1, 1]), [3, 3, 2, 2]));
test("zero total", () => assert.deepEqual(allocate(0, [1, 2]), [0, 0]));
test("always sums to total", () => {
  for (const [t, w] of [[101, [1, 2, 3, 4]], [7, [5, 5, 5]], [999, [10, 1, 1]]]) assert.equal(allocate(t, w).reduce((a, b) => a + b, 0), t);
});
`,
    },
    solution: {
      "allocate.mjs": `export function allocate(totalCents, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const out = weights.map((w) => Math.floor((totalCents * w) / sum));
  let left = totalCents - out.reduce((a, b) => a + b, 0);
  const order = weights.map((w, i) => i).sort((a, b) => weights[b] - weights[a] || a - b);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k]]++;
  return out;
}
`,
    },
  },
  {
    id: "intervals",
    files: {
      "intervals.mjs": `// Merge overlapping or touching [start, end] intervals. Return them sorted by start.
// Do not mutate the input.
export function mergeIntervals(list) {
  const out = [];
  for (const [s, e] of list) {
    const last = out[out.length - 1];
    if (last && s < last[1]) last[1] = e;
    else out.push([s, e]);
  }
  return out;
}
`,
      "test.mjs": T() + `import { mergeIntervals } from "./intervals.mjs";
test("overlap", () => assert.deepEqual(mergeIntervals([[1, 3], [2, 6], [8, 10]]), [[1, 6], [8, 10]]));
test("unsorted input", () => assert.deepEqual(mergeIntervals([[8, 10], [1, 3], [2, 6]]), [[1, 6], [8, 10]]));
test("contained", () => assert.deepEqual(mergeIntervals([[1, 10], [2, 3], [4, 5]]), [[1, 10]]));
test("touching", () => assert.deepEqual(mergeIntervals([[1, 2], [2, 3], [5, 6]]), [[1, 3], [5, 6]]));
test("no mutation", () => {
  const input = [[5, 6], [1, 4], [2, 3]]; const snap = JSON.parse(JSON.stringify(input));
  mergeIntervals(input); assert.deepEqual(input, snap);
});
test("empty", () => assert.deepEqual(mergeIntervals([]), []));
`,
    },
    solution: {
      "intervals.mjs": `export function mergeIntervals(list) {
  const sorted = list.map(([s, e]) => [s, e]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}
`,
    },
  },
  {
    id: "h-ordered-buffer",
    files: {
      "buffer.mjs": `// Per-conversation in-order delivery. Messages are { conv, seq, body }; seq starts at 1 in every conversation.
// push(msg) returns the messages that can be delivered now, in order: a message is deliverable once every
// lower seq of its conversation has been delivered. Later messages are held until the gap closes.
// Duplicates are ignored (seq already delivered, or already held: the first copy wins) and return [].
// skip(conv) gives up on the missing messages: delivery resumes at the lowest held seq, and skip returns
// everything deliverable from there ([] when nothing is held). Messages below that point are late and ignored.
// pending(conv) returns the held seqs in ascending order ([] for an unknown conversation).
export class OrderedBuffer {
  push(msg) { throw new Error("not implemented"); }
  skip(conv) { throw new Error("not implemented"); }
  pending(conv) { throw new Error("not implemented"); }
}
`,
      "test.mjs": T() + `import { OrderedBuffer } from "./buffer.mjs";
const m = (conv, seq, body = conv + seq) => ({ conv, seq, body });
const seqs = (list) => list.map((x) => x.seq);
test("in order", () => { const b = new OrderedBuffer(); assert.deepEqual(seqs(b.push(m("a", 1))), [1]); assert.deepEqual(seqs(b.push(m("a", 2))), [2]); });
test("holds until the gap closes", () => {
  const b = new OrderedBuffer();
  assert.deepEqual(b.push(m("a", 3)), []); assert.deepEqual(b.push(m("a", 2)), []); assert.deepEqual(b.pending("a"), [2, 3]);
  assert.deepEqual(seqs(b.push(m("a", 1))), [1, 2, 3]); assert.deepEqual(b.pending("a"), []);
});
test("duplicates", () => {
  const b = new OrderedBuffer();
  b.push(m("a", 1)); assert.deepEqual(b.push(m("a", 1)), []);
  b.push(m("a", 3, "first")); assert.deepEqual(b.push(m("a", 3, "second")), []);
  assert.deepEqual(b.push(m("a", 2)).map((x) => x.body), ["a2", "first"]);
});
test("conversations are independent", () => {
  const b = new OrderedBuffer();
  assert.deepEqual(b.push(m("a", 2)), []); assert.deepEqual(seqs(b.push(m("b", 1))), [1]); assert.deepEqual(b.pending("b"), []); assert.deepEqual(b.pending("zzz"), []);
});
test("skip resumes at the lowest held seq", () => {
  const b = new OrderedBuffer();
  b.push(m("a", 1)); b.push(m("a", 4)); b.push(m("a", 5)); b.push(m("a", 8));
  assert.deepEqual(seqs(b.skip("a")), [4, 5]); assert.deepEqual(b.pending("a"), [8]);
  assert.deepEqual(b.push(m("a", 2)), []); assert.deepEqual(seqs(b.push(m("a", 6))), [6]);
  assert.deepEqual(seqs(b.skip("a")), [8]); assert.deepEqual(b.skip("a"), []); assert.deepEqual(b.skip("nobody"), []);
  assert.deepEqual(seqs(b.push(m("a", 9))), [9]);
});
`,
    },
    solution: {
      "buffer.mjs": `export class OrderedBuffer {
  constructor() { this.next = new Map(); this.held = new Map(); }
  _held(conv) { if (!this.next.has(conv)) { this.next.set(conv, 1); this.held.set(conv, new Map()); } return this.held.get(conv); }
  _drain(conv) {
    const held = this._held(conv); const out = []; let n = this.next.get(conv);
    while (held.has(n)) { out.push(held.get(n)); held.delete(n); n++; }
    this.next.set(conv, n); return out;
  }
  push(msg) {
    const held = this._held(msg.conv);
    if (msg.seq < this.next.get(msg.conv) || held.has(msg.seq)) return [];
    held.set(msg.seq, msg); return this._drain(msg.conv);
  }
  skip(conv) {
    if (!this.next.has(conv)) return [];
    const held = this._held(conv); if (!held.size) return [];
    this.next.set(conv, Math.min(...held.keys())); return this._drain(conv);
  }
  pending(conv) { return this.held.has(conv) ? [...this.held.get(conv).keys()].sort((a, b) => a - b) : []; }
}
`,
    },
  },
  {
    id: "h-sliding-limiter",
    files: {
      "limiter.mjs": `// Sliding-window limiter. allow(key, now) returns { ok: true } and records the request while fewer than
// the key's limit of recorded requests fall inside the window; a request made at time t is inside the
// window while now - t < windowMs. Otherwise it returns { ok: false, retryAfterMs } where retryAfterMs is
// the time until the OLDEST request in the window leaves it (windowMs when there is none, i.e. limit 0).
// Rejected requests are not recorded. setLimit(key, n) overrides the limit for one key; 0 blocks the key.
// Keys are arbitrary strings.
export class SlidingLimiter {
  constructor({ limit, windowMs }) { this.limit = limit; this.windowMs = windowMs; this.hits = new Map(); this.overrides = {}; }
  setLimit(key, n) { this.overrides[key] = n; }
  allow(key, now) {
    const list = this.hits.get(key) || [];
    const fresh = list.filter((t) => now - t <= this.windowMs);
    fresh.push(now);
    this.hits.set(key, fresh);
    const limit = this.overrides[key] || this.limit;
    if (fresh.length > limit) return { ok: false, retryAfterMs: this.windowMs - (now - fresh[fresh.length - 1]) };
    return { ok: true };
  }
}
`,
      "test.mjs": T() + `import { SlidingLimiter } from "./limiter.mjs";
test("rejects over the limit with time until the oldest leaves", () => {
  const l = new SlidingLimiter({ limit: 2, windowMs: 1000 });
  assert.deepEqual(l.allow("k", 0), { ok: true }); assert.deepEqual(l.allow("k", 100), { ok: true });
  assert.deepEqual(l.allow("k", 200), { ok: false, retryAfterMs: 800 });
});
test("rejected requests are not recorded and the window edge is exclusive", () => {
  const l = new SlidingLimiter({ limit: 2, windowMs: 1000 });
  l.allow("k", 0); l.allow("k", 100); l.allow("k", 200); l.allow("k", 300);
  assert.deepEqual(l.allow("k", 1000), { ok: true });
  assert.deepEqual(l.allow("k", 1050), { ok: false, retryAfterMs: 50 });
  assert.deepEqual(l.allow("k", 1100), { ok: true });
});
test("keys are independent", () => {
  const l = new SlidingLimiter({ limit: 1, windowMs: 1000 });
  assert.equal(l.allow("a", 0).ok, true); assert.equal(l.allow("b", 0).ok, true); assert.equal(l.allow("a", 1).ok, false);
});
test("per-key override including zero", () => {
  const l = new SlidingLimiter({ limit: 1, windowMs: 1000 });
  l.setLimit("vip", 3); l.setLimit("banned", 0);
  assert.deepEqual([0, 1, 2, 3].map((t) => l.allow("vip", t).ok), [true, true, true, false]);
  assert.deepEqual(l.allow("banned", 5), { ok: false, retryAfterMs: 1000 });
});
test("keys that look like object properties", () => {
  const l = new SlidingLimiter({ limit: 1, windowMs: 1000 });
  for (const key of ["constructor", "toString", "__proto__"]) { assert.equal(l.allow(key, 0).ok, true, key); assert.equal(l.allow(key, 1).ok, false, key); }
});
`,
    },
    solution: {
      "limiter.mjs": `export class SlidingLimiter {
  constructor({ limit, windowMs }) { this.limit = limit; this.windowMs = windowMs; this.hits = new Map(); this.overrides = new Map(); }
  setLimit(key, n) { this.overrides.set(key, n); }
  allow(key, now) {
    const fresh = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    const limit = this.overrides.has(key) ? this.overrides.get(key) : this.limit;
    if (fresh.length >= limit) {
      this.hits.set(key, fresh);
      return { ok: false, retryAfterMs: fresh.length ? this.windowMs - (now - fresh[0]) : this.windowMs };
    }
    fresh.push(now); this.hits.set(key, fresh);
    return { ok: true };
  }
}
`,
    },
  },
  {
    id: "h-cron-next",
    files: {
      "cron.mjs": `// nextRun(expr, from) -> Date: the first whole minute strictly after \`from\` (a Date) that matches the cron
// expression, evaluated in UTC. expr has exactly five space-separated fields:
//   minute(0-59) hour(0-23) day-of-month(1-31) month(1-12) day-of-week(0-6, Sunday = 0)
// Each field supports "*", a number, lists "a,b,c", ranges "a-b" and steps "*/n" or "a-b/n".
// As in standard cron, when BOTH day-of-month and day-of-week are restricted (neither is "*"), a day
// matches if EITHER of them matches; otherwise both fields must match.
// Throw an Error for a malformed expression (wrong field count, non-numeric or out-of-range values).
export function nextRun(expr, from) {
  throw new Error("not implemented");
}
`,
      "test.mjs": T() + `import { nextRun } from "./cron.mjs";
const at = (expr, from) => nextRun(expr, new Date(from)).toISOString();
test("step minutes", () => assert.equal(at("*/15 * * * *", "2026-01-01T10:07:30Z"), "2026-01-01T10:15:00.000Z"));
test("strictly after", () => assert.equal(at("0 * * * *", "2026-01-01T10:00:00Z"), "2026-01-01T11:00:00.000Z"));
test("weekdays", () => assert.equal(at("30 9 * * 1-5", "2026-11-13T10:00:00Z"), "2026-11-16T09:30:00.000Z"));
test("leap day", () => assert.equal(at("0 0 29 2 *", "2025-03-01T00:00:00Z"), "2028-02-29T00:00:00.000Z"));
test("day-of-month OR day-of-week", () => assert.equal(at("0 12 13 * 5", "2026-11-13T12:00:00Z"), "2026-11-20T12:00:00.000Z"));
test("day-of-month only", () => assert.equal(at("0 12 13 * *", "2026-11-13T12:00:00Z"), "2026-12-13T12:00:00.000Z"));
test("month list", () => assert.equal(at("0 0 1 1,7 *", "2026-02-01T00:00:00Z"), "2026-07-01T00:00:00.000Z"));
test("range with step and year rollover", () => {
  assert.equal(at("5-10/5 23 31 12 *", "2026-12-31T23:05:00Z"), "2026-12-31T23:10:00.000Z");
  assert.equal(at("5-10/5 23 31 12 *", "2026-12-31T23:10:00Z"), "2027-12-31T23:05:00.000Z");
});
test("malformed", () => {
  for (const bad of ["61 * * * *", "* * *", "a * * * *", "* * 0 * *", "*/0 * * * *", "5-1 * * * *"]) assert.throws(() => nextRun(bad, new Date("2026-01-01T00:00:00Z")), Error, bad);
});
`,
    },
    solution: {
      "cron.mjs": `const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
function parseField(text, [lo, hi]) {
  const out = new Set();
  for (const part of text.split(",")) {
    const m = part.match(/^(\\*|\\d+(?:-\\d+)?)(?:\\/(\\d+))?$/);
    if (!m) throw new Error("malformed field: " + text);
    let a = lo; let b = hi;
    if (m[1] !== "*") { const [x, y] = m[1].split("-").map(Number); a = x; b = y === undefined ? (m[2] ? hi : x) : y; }
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1 || a < lo || b > hi || a > b) throw new Error("out of range: " + text);
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}
export function nextRun(expr, from) {
  const fields = String(expr).trim().split(/\\s+/);
  if (fields.length !== 5) throw new Error("expected five fields");
  const [min, hour, dom, mon, dow] = fields.map((f, i) => parseField(f, RANGES[i]));
  const domAny = fields[2] === "*"; const dowAny = fields[4] === "*";
  let t = Math.floor(from.getTime() / 60000) * 60000 + 60000;
  for (let i = 0; i < 60 * 24 * 366 * 8; i++, t += 60000) {
    const d = new Date(t);
    if (!min.has(d.getUTCMinutes()) || !hour.has(d.getUTCHours()) || !mon.has(d.getUTCMonth() + 1)) continue;
    const domOk = dom.has(d.getUTCDate()); const dowOk = dow.has(d.getUTCDay());
    const dayOk = domAny || dowAny ? domOk && dowOk : domOk || dowOk;
    if (dayOk) return d;
  }
  throw new Error("no matching time");
}
`,
    },
  },
  {
    id: "h-expr",
    files: {
      "expr.mjs": `// evaluate(source, env) evaluates an arithmetic expression.
// Precedence, lowest to highest: + -  (left-assoc)  <  * / %  (left-assoc)  <  unary minus  <  ^ (right-assoc).
// So -2^2 is -(2^2) = -4, 2^3^2 is 2^(3^2) = 512, and 2^-1 is 0.5.
// Numbers may have a decimal part (1.5, .5). Identifiers are variables looked up in env, or the functions
// min(a, b, ...), max(a, b, ...) and abs(x). Errors (all thrown as Error): "unknown variable <name>",
// "division by zero" for / or % by zero, and a syntax error for anything left over or malformed.
function tokenize(src) {
  const tokens = [];
  const re = /\\s*(\\d+|[A-Za-z_]\\w*|[-+*/%^(),])/y;
  let m; let pos = 0;
  while (pos < src.length && (m = (re.lastIndex = pos, re.exec(src)))) { tokens.push(m[1]); pos = re.lastIndex; }
  return tokens;
}

export function evaluate(source, env = {}) {
  const tokens = tokenize(source);
  let i = 0;
  const peek = () => tokens[i];
  const take = () => tokens[i++];

  function expr() {
    let left = term();
    if (peek() === "+") { take(); return left + expr(); }
    if (peek() === "-") { take(); return left - expr(); }
    return left;
  }
  function term() {
    let left = power();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = take(); const right = power();
      if (op === "*") left *= right; else if (op === "/") left /= right; else left %= right;
    }
    return left;
  }
  function power() {
    let base = unary();
    while (peek() === "^") { take(); base = base ** unary(); }
    return base;
  }
  function unary() {
    if (peek() === "-") { take(); return -unary(); }
    return primary();
  }
  function primary() {
    const tok = take();
    if (tok === "(") { const v = expr(); take(); return v; }
    if (/^\\d/.test(tok)) return Number(tok);
    if (peek() === "(") {
      take(); const args = [expr()];
      while (peek() === ",") { take(); args.push(expr()); }
      take();
      return Math[tok](...args);
    }
    return env[tok];
  }
  return expr();
}
`,
      "test.mjs": T() + `import { evaluate } from "./expr.mjs";
test("precedence", () => { assert.equal(evaluate("2 + 3 * 4"), 14); assert.equal(evaluate("(2 + 3) * 4"), 20); assert.equal(evaluate("7 % 4 * 2"), 6); });
test("left associativity", () => { assert.equal(evaluate("10 - 4 - 3"), 3); assert.equal(evaluate("100 / 10 / 5"), 2); assert.equal(evaluate("1 - 2 + 3"), 2); });
test("power", () => { assert.equal(evaluate("2 ^ 3 ^ 2"), 512); assert.equal(evaluate("-2 ^ 2"), -4); assert.equal(evaluate("2 ^ -1"), 0.5); assert.equal(evaluate("(-2) ^ 2"), 4); });
test("unary", () => { assert.equal(evaluate("--3"), 3); assert.equal(evaluate("2 * -3"), -6); assert.equal(evaluate("5 - -2"), 7); });
test("decimals", () => { assert.equal(evaluate("1.5 * 2"), 3); assert.equal(evaluate(".5 + .25"), 0.75); });
test("variables and functions", () => {
  assert.equal(evaluate("price * qty - discount", { price: 12.5, qty: 4, discount: 5 }), 45);
  assert.equal(evaluate("max(1, x, 3) + min(4, 2) + abs(-7)", { x: 9 }), 18);
  assert.equal(evaluate("zero + 1", { zero: 0 }), 1);
});
test("errors", () => {
  assert.throws(() => evaluate("a + 1"), /unknown variable a/);
  assert.throws(() => evaluate("toString + 1"), /unknown variable toString/);
  assert.throws(() => evaluate("1 / 0"), /division by zero/);
  assert.throws(() => evaluate("5 % (2 - 2)"), /division by zero/);
  for (const bad of ["2 3", "(1 + 2", "1 +", "", "2 $ 3", "sqrt(4)", "1 + )"]) assert.throws(() => evaluate(bad), Error, bad);
});
`,
    },
    solution: {
      "expr.mjs": `function tokenize(src) {
  const tokens = [];
  const re = /\\s*(?:(\\d+\\.?\\d*|\\.\\d+)|([A-Za-z_]\\w*)|([-+*/%^(),]))/y;
  let pos = 0;
  while (pos < src.length) {
    if (/^\\s*$/.test(src.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) throw new Error("syntax error at " + pos);
    if (m[1] !== undefined) tokens.push({ t: "num", v: Number(m[1]) });
    else if (m[2] !== undefined) tokens.push({ t: "id", v: m[2] });
    else tokens.push({ t: "op", v: m[3] });
    pos = re.lastIndex;
  }
  return tokens;
}
const FUNCS = { min: Math.min, max: Math.max, abs: (x) => Math.abs(x) };
export function evaluate(source, env = {}) {
  const tokens = tokenize(String(source));
  let i = 0;
  const isOp = (v) => tokens[i] && tokens[i].t === "op" && tokens[i].v === v;
  const expect = (v) => { if (!isOp(v)) throw new Error("syntax error: expected " + v); i++; };
  function expr() {
    let left = term();
    while (isOp("+") || isOp("-")) { const op = tokens[i++].v; const right = term(); left = op === "+" ? left + right : left - right; }
    return left;
  }
  function term() {
    let left = unary();
    while (isOp("*") || isOp("/") || isOp("%")) {
      const op = tokens[i++].v; const right = unary();
      if (op !== "*" && right === 0) throw new Error("division by zero");
      left = op === "*" ? left * right : op === "/" ? left / right : left % right;
    }
    return left;
  }
  function unary() { if (isOp("-")) { i++; return -unary(); } return power(); }
  function power() { const base = primary(); if (isOp("^")) { i++; return base ** unary(); } return base; }
  function primary() {
    const tok = tokens[i++];
    if (!tok) throw new Error("syntax error: unexpected end");
    if (tok.t === "num") return tok.v;
    if (tok.t === "op" && tok.v === "(") { const v = expr(); expect(")"); return v; }
    if (tok.t === "id") {
      if (isOp("(")) {
        i++;
        if (!Object.prototype.hasOwnProperty.call(FUNCS, tok.v)) throw new Error("syntax error: unknown function " + tok.v);
        const args = [expr()];
        while (isOp(",")) { i++; args.push(expr()); }
        expect(")");
        return FUNCS[tok.v](...args);
      }
      if (!Object.prototype.hasOwnProperty.call(env, tok.v)) throw new Error("unknown variable " + tok.v);
      return env[tok.v];
    }
    throw new Error("syntax error: unexpected " + tok.v);
  }
  const value = expr();
  if (i < tokens.length) throw new Error("syntax error: unexpected trailing input");
  return value;
}
`,
    },
  },
];
