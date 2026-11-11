// Request details record which client API key sent a request, so the Usage
// "Details" tab can show and filter by caller. The key itself must never be
// persisted or returned: only its id, a name snapshot, or a masked string.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
const originalRequestLogs = process.env.ENABLE_REQUEST_LOGS;

async function boot() {
  delete global._dbAdapter;
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  const repo = await import("@/lib/db/repos/requestDetailsRepo.js");
  const route = await import("@/app/api/usage/request-details/route.js");
  const { getAdapter } = await import("@/lib/db/driver.js");
  return { db, repo, route, adapter: await getAdapter() };
}

const detail = (over = {}) => ({
  provider: "codex", model: "gpt-6-luna", status: "success",
  latency: { ttft: 10, total: 20 }, tokens: { prompt_tokens: 5, completion_tokens: 1 },
  request: { headers: {} }, response: {},
  ...over,
});

const list = async (route, query = "") =>
  (await route.GET(new Request(`http://localhost/api/usage/request-details${query}`))).json();

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-detail-key-"));
  process.env.DATA_DIR = tempDir;
  // Request details are off by default; turn them on for these tests.
  process.env.ENABLE_REQUEST_LOGS = "true";
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalRequestLogs === undefined) delete process.env.ENABLE_REQUEST_LOGS;
  else process.env.ENABLE_REQUEST_LOGS = originalRequestLogs;
});

describe("request details: caller API key", () => {
  it("stores the key id and name, never the key itself", async () => {
    const { db, repo, adapter } = await boot();
    const key = await db.createApiKey("lab", "machine-1", "sk-fresp-lab-secret");

    await repo.saveRequestDetail(detail({ id: "d1", apiKey: key.key }));
    await repo.__test__.flush();

    const row = adapter.get(`SELECT apiKeyId, data FROM requestDetails WHERE id = 'd1'`);
    expect(row.apiKeyId).toBe(key.id);
    expect(JSON.parse(row.data)).toMatchObject({ apiKeyId: key.id, apiKeyName: "lab" });
    expect(row.data).not.toContain("sk-fresp-lab-secret");
  });

  it("stores only a masked string for a key that is not registered", async () => {
    const { repo, adapter } = await boot();
    await repo.saveRequestDetail(detail({ id: "d1", apiKey: "sk-unknown-client-key-123456" }));
    await repo.__test__.flush();

    const row = adapter.get(`SELECT apiKeyId, data FROM requestDetails WHERE id = 'd1'`);
    expect(row.apiKeyId).toBeNull();
    expect(JSON.parse(row.data).apiKeyMasked).toBe("sk-unkno***3456");
    expect(row.data).not.toContain("sk-unknown-client-key-123456");
  });

  it("a streaming update (same id) keeps the caller", async () => {
    const { db, repo, adapter } = await boot();
    const key = await db.createApiKey("lab", "machine-1");
    await repo.saveRequestDetail(detail({ id: "d1", status: "pending", apiKey: key.key }));
    await repo.saveRequestDetail(detail({ id: "d1", status: "success", apiKey: key.key }));
    await repo.__test__.flush();

    const rows = adapter.all(`SELECT apiKeyId, status FROM requestDetails`);
    expect(rows).toEqual([{ apiKeyId: key.id, status: "success" }]);
  });

  it("filters by apiKeyId", async () => {
    const { db, repo } = await boot();
    const a = await db.createApiKey("a", "machine-1");
    const b = await db.createApiKey("b", "machine-1");
    await repo.saveRequestDetail(detail({ id: "d1", apiKey: a.key }));
    await repo.saveRequestDetail(detail({ id: "d2", apiKey: b.key }));
    await repo.saveRequestDetail(detail({ id: "d3" }));
    await repo.__test__.flush();

    const onlyA = await repo.getRequestDetails({ apiKeyId: a.id });
    expect(onlyA.details.map((d) => d.id)).toEqual(["d1"]);
    expect(onlyA.pagination.totalItems).toBe(1);
    expect((await repo.getRequestDetails({})).pagination.totalItems).toBe(3);
  });
});

describe("GET /api/usage/request-details: caller", () => {
  it("returns current name and group, and no key material", async () => {
    const { db, repo, route } = await boot();
    const group = await db.createApiKeyGroup("Lab");
    const key = await db.createApiKey("lab", "machine-1", "sk-fresp-lab-secret");
    await db.updateApiKey(key.id, { groupId: group.id });
    await repo.saveRequestDetail(detail({ id: "d1", apiKey: key.key }));
    await repo.saveRequestDetail(detail({ id: "d2" }));
    await repo.__test__.flush();

    const body = await list(route);
    const byId = Object.fromEntries(body.details.map((d) => [d.id, d]));
    expect(byId.d1.apiKey).toEqual({ id: key.id, name: "lab", group: "Lab", deleted: false });
    expect(byId.d2.apiKey).toBeNull();
    expect(JSON.stringify(body)).not.toContain("sk-fresp-lab-secret");
    expect(byId.d1).not.toHaveProperty("apiKeyId");
  });

  it("follows a rename and survives key deletion with the stored name", async () => {
    const { db, repo, route } = await boot();
    const key = await db.createApiKey("old-name", "machine-1");
    await repo.saveRequestDetail(detail({ id: "d1", apiKey: key.key }));
    await repo.__test__.flush();

    await db.updateApiKey(key.id, { name: "new-name" });
    expect((await list(route)).details[0].apiKey.name).toBe("new-name");

    await db.deleteApiKey(key.id);
    expect((await list(route)).details[0].apiKey).toEqual({ id: key.id, name: "old-name", group: null, deleted: true });
  });

  it("marks an unregistered key as unknown and filters by apiKeyId", async () => {
    const { db, repo, route } = await boot();
    const key = await db.createApiKey("lab", "machine-1");
    await repo.saveRequestDetail(detail({ id: "d1", apiKey: key.key }));
    await repo.saveRequestDetail(detail({ id: "d2", apiKey: "sk-unknown-client-key-123456" }));
    await repo.__test__.flush();

    const all = await list(route);
    const unknown = all.details.find((d) => d.id === "d2");
    expect(unknown.apiKey).toEqual({ id: null, name: "sk-unkno***3456", group: null, unknown: true });

    const filtered = await list(route, `?apiKeyId=${key.id}`);
    expect(filtered.details.map((d) => d.id)).toEqual(["d1"]);
  });
});

describe("usage stats: key group on the API key breakdown", () => {
  it("carries the group name of the key", async () => {
    const { db } = await boot();
    const group = await db.createApiKeyGroup("Lab");
    const key = await db.createApiKey("lab", "machine-1");
    await db.updateApiKey(key.id, { groupId: group.id });
    const other = await db.createApiKey("solo", "machine-1");

    const { saveRequestUsage, getUsageStats } = await import("@/lib/db/repos/usageRepo.js");
    for (const k of [key, other]) {
      await saveRequestUsage({ provider: "codex", model: "gpt-6-luna", apiKey: k.key, tokens: { prompt_tokens: 10, completion_tokens: 2 } });
    }

    const stats = await getUsageStats("today");
    const rows = Object.values(stats.byApiKey);
    expect(rows.find((r) => r.keyName === "lab").keyGroup).toBe("Lab");
    expect(rows.find((r) => r.keyName === "solo").keyGroup).toBeNull();
  });
});
