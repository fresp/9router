// API key groups: organizing containers for keys. Covers name validation, the
// repo (create, membership, bulk toggle, delete), the /api/keys/groups routes,
// upgrade from the previous schema, and backup export/import.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { validateKeyGroupName } from "@/shared/utils/apiKeyGroup.js";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

async function boot() {
  delete global._dbAdapter;
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  const groupsRoute = await import("@/app/api/keys/groups/route.js");
  const groupRoute = await import("@/app/api/keys/groups/[id]/route.js");
  const keyRoute = await import("@/app/api/keys/[id]/route.js");
  return { db, groupsRoute, groupRoute, keyRoute };
}

function req(method, body) {
  return new Request("http://localhost/api/keys/groups", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const ctx = (id) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-key-groups-"));
  process.env.DATA_DIR = tempDir;
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("validateKeyGroupName", () => {
  it("trims and accepts a normal name", () => {
    expect(validateKeyGroupName("  Lab ")).toEqual({ ok: true, value: "Lab" });
  });

  it.each([
    ["empty", "   "],
    ["too long", "x".repeat(41)],
    ["non-string", 42],
  ])("rejects %s", (_label, input) => {
    expect(validateKeyGroupName(input).ok).toBe(false);
  });
});

describe("key groups repo", () => {
  it("creates groups and rejects a duplicate name case-insensitively", async () => {
    const { db } = await boot();
    const lab = await db.createApiKeyGroup("Lab");
    expect(lab).toMatchObject({ name: "Lab" });
    await expect(db.createApiKeyGroup("lab")).rejects.toMatchObject({ code: "API_KEY_GROUP_EXISTS" });
    expect((await db.getApiKeyGroups()).map((g) => g.name)).toEqual(["Lab"]);
  });

  it("new keys are ungrouped; membership moves with updateApiKey", async () => {
    const { db } = await boot();
    const lab = await db.createApiKeyGroup("Lab");
    const tools = await db.createApiKeyGroup("Tools");
    const key = await db.createApiKey("k", "machine-1");
    expect(key.groupId).toBeNull();

    expect((await db.updateApiKey(key.id, { groupId: lab.id })).groupId).toBe(lab.id);
    expect((await db.updateApiKey(key.id, { groupId: tools.id })).groupId).toBe(tools.id);
    expect((await db.updateApiKey(key.id, { groupId: null })).groupId).toBeNull();
  });

  it("membership changes leave the key's active state and access alone", async () => {
    const { db } = await boot();
    const lab = await db.createApiKeyGroup("Lab");
    const key = await db.createApiKey("k", "machine-1");
    await db.updateApiKey(key.id, { isActive: false, access: { restricted: true, allow: ["cx/gpt-5"] } });

    const moved = await db.updateApiKey(key.id, { groupId: lab.id });
    expect(moved.isActive).toBe(false);
    expect(moved.access).toEqual({ restricted: true, allow: ["cx/gpt-5"] });
    expect(await db.validateApiKey(key.key)).toBe(false);
  });

  it("bulk toggle only touches the group's own keys", async () => {
    const { db } = await boot();
    const lab = await db.createApiKeyGroup("Lab");
    const a = await db.createApiKey("a", "machine-1");
    const b = await db.createApiKey("b", "machine-1");
    const outside = await db.createApiKey("outside", "machine-1");
    await db.updateApiKey(a.id, { groupId: lab.id });
    await db.updateApiKey(b.id, { groupId: lab.id });

    expect(await db.setApiKeyGroupActive(lab.id, false)).toBe(2);
    expect(await db.validateApiKey(a.key)).toBe(false);
    expect(await db.validateApiKey(b.key)).toBe(false);
    expect(await db.validateApiKey(outside.key)).toBe(true);

    await db.setApiKeyGroupActive(lab.id, true);
    expect(await db.validateApiKey(a.key)).toBe(true);
  });

  it("deleting a group keeps its keys, ungrouped, with access intact", async () => {
    const { db } = await boot();
    const lab = await db.createApiKeyGroup("Lab");
    const key = await db.createApiKey("k", "machine-1");
    await db.updateApiKey(key.id, { groupId: lab.id, access: { restricted: true, allow: ["cx/gpt-5"] } });

    expect(await db.deleteApiKeyGroup(lab.id)).toBe(true);
    expect(await db.deleteApiKeyGroup(lab.id)).toBe(false);
    const after = await db.getApiKeyById(key.id);
    expect(after.groupId).toBeNull();
    expect(after.access).toEqual({ restricted: true, allow: ["cx/gpt-5"] });
    expect(await db.validateApiKey(key.key)).toBe(true);
  });
});

describe("/api/keys/groups routes", () => {
  it("creates, lists, rejects invalid and duplicate names", async () => {
    const { groupsRoute } = await boot();
    const created = await groupsRoute.POST(req("POST", { name: " Lab " }));
    expect(created.status).toBe(201);
    expect((await created.json()).group.name).toBe("Lab");

    expect((await groupsRoute.POST(req("POST", { name: "" }))).status).toBe(400);
    expect((await groupsRoute.POST(req("POST", { name: "LAB" }))).status).toBe(409);

    const listed = await (await groupsRoute.GET()).json();
    expect(listed.groups.map((g) => g.name)).toEqual(["Lab"]);
  });

  it("PUT /api/keys/[id] sets and clears groupId and rejects an unknown group", async () => {
    const { db, keyRoute } = await boot();
    const lab = await db.createApiKeyGroup("Lab");
    const key = await db.createApiKey("k", "machine-1");

    const set = await keyRoute.PUT(req("PUT", { groupId: lab.id }), ctx(key.id));
    expect(set.status).toBe(200);
    expect((await set.json()).key.groupId).toBe(lab.id);

    expect((await keyRoute.PUT(req("PUT", { groupId: "nope" }), ctx(key.id))).status).toBe(400);
    expect((await keyRoute.PUT(req("PUT", { groupId: 7 }), ctx(key.id))).status).toBe(400);
    expect((await db.getApiKeyById(key.id)).groupId).toBe(lab.id);

    const cleared = await keyRoute.PUT(req("PUT", { groupId: null }), ctx(key.id));
    expect((await cleared.json()).key.groupId).toBeNull();
  });

  it("bulk toggle and delete validate the group", async () => {
    const { db, groupRoute } = await boot();
    const lab = await db.createApiKeyGroup("Lab");
    const key = await db.createApiKey("k", "machine-1");
    await db.updateApiKey(key.id, { groupId: lab.id });

    expect((await groupRoute.PUT(req("PUT", { isActive: "no" }), ctx(lab.id))).status).toBe(400);
    expect((await groupRoute.PUT(req("PUT", { isActive: false }), ctx("missing"))).status).toBe(404);

    const paused = await groupRoute.PUT(req("PUT", { isActive: false }), ctx(lab.id));
    expect((await paused.json()).updated).toBe(1);
    expect(await db.validateApiKey(key.key)).toBe(false);

    expect((await groupRoute.DELETE(req("DELETE"), ctx(lab.id))).status).toBe(200);
    expect((await groupRoute.DELETE(req("DELETE"), ctx(lab.id))).status).toBe(404);
  });
});

describe("bulk group access", () => {
  const ACCESS = { restricted: true, allow: ["oca-code", "cx/gpt-5"] };

  it("overwrites access for the group's own keys only", async () => {
    const { db } = await boot();
    const lab = await db.createApiKeyGroup("Lab");
    const a = await db.createApiKey("a", "machine-1");
    const b = await db.createApiKey("b", "machine-1");
    const outside = await db.createApiKey("outside", "machine-1");
    await db.updateApiKey(a.id, { groupId: lab.id, access: { restricted: true, allow: ["old/model"] } });
    await db.updateApiKey(b.id, { groupId: lab.id, isActive: false });
    await db.updateApiKey(outside.id, { access: { restricted: true, allow: ["keep/me"] } });

    expect(await db.setApiKeyGroupAccess(lab.id, ACCESS)).toBe(2);
    expect((await db.getApiKeyById(a.id)).access).toEqual(ACCESS);
    expect((await db.getApiKeyById(b.id)).access).toEqual(ACCESS);
    expect((await db.getApiKeyById(b.id)).isActive).toBe(false);
    expect((await db.getApiKeyById(outside.id)).access).toEqual({ restricted: true, allow: ["keep/me"] });

    await db.setApiKeyGroupAccess(lab.id, { restricted: false, allow: [] });
    expect((await db.getApiKeyById(a.id)).access).toEqual({ restricted: false, allow: [] });
  });

  it("a key that joins later keeps its own access", async () => {
    const { db } = await boot();
    const lab = await db.createApiKeyGroup("Lab");
    await db.setApiKeyGroupAccess(lab.id, ACCESS);
    const late = await db.createApiKey("late", "machine-1");
    expect((await db.updateApiKey(late.id, { groupId: lab.id })).access).toEqual({ restricted: false, allow: [] });
  });

  it("PUT validates access and the group, and leaves keys alone on a bad request", async () => {
    const { db, groupRoute } = await boot();
    const lab = await db.createApiKeyGroup("Lab");
    const key = await db.createApiKey("k", "machine-1");
    await db.updateApiKey(key.id, { groupId: lab.id, access: { restricted: true, allow: ["old/model"] } });

    expect((await groupRoute.PUT(req("PUT", {}), ctx(lab.id))).status).toBe(400);
    expect((await groupRoute.PUT(req("PUT", { access: { restricted: "yes" } }), ctx(lab.id))).status).toBe(400);
    expect((await groupRoute.PUT(req("PUT", { access: { restricted: true, allow: [1] } }), ctx(lab.id))).status).toBe(400);
    expect((await groupRoute.PUT(req("PUT", { access: ACCESS, isActive: "no" }), ctx(lab.id))).status).toBe(400);
    expect((await groupRoute.PUT(req("PUT", { access: ACCESS }), ctx("missing"))).status).toBe(404);
    expect((await db.getApiKeyById(key.id)).access).toEqual({ restricted: true, allow: ["old/model"] });

    const res = await groupRoute.PUT(req("PUT", { access: { restricted: true, allow: [" oca-code ", "OCA-CODE", "cx/gpt-5"] } }), ctx(lab.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 1, access: ACCESS });
    expect((await db.getApiKeyById(key.id)).access).toEqual(ACCESS);
    expect(await db.validateApiKey(key.key)).toBe(true);
  });
});

describe("key groups: schema upgrade and backup", () => {
  it("upgrades a DB from the previous schema with every key ungrouped", async () => {
    // apiKeys as it was before groupId, stamped at schema version 2.
    fs.mkdirSync(path.join(tempDir, "db"), { recursive: true });
    const legacy = new DatabaseSync(path.join(tempDir, "db", "data.sqlite"));
    legacy.exec(`CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    legacy.exec(`INSERT INTO _meta(key, value) VALUES ('schemaVersion', '1'), ('backupSchemaVersion', '2')`);
    legacy.exec(`CREATE TABLE apiKeys (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT, machineId TEXT, isActive INTEGER DEFAULT 1, createdAt TEXT NOT NULL, accessRestricted INTEGER DEFAULT 0, accessAllow TEXT)`);
    legacy.prepare(`INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, accessRestricted, accessAllow) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("k1", "sk-legacy-one", "Default Key", "m", 1, "2026-09-01T00:00:00.000Z", 1, JSON.stringify(["cx/gpt-5"]));
    legacy.close();

    const { db } = await boot();
    const keys = await db.getApiKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0].groupId).toBeNull();
    expect(keys[0].access).toEqual({ restricted: true, allow: ["cx/gpt-5"] });
    expect(await db.getApiKeyGroups()).toEqual([]);
    expect(await db.validateApiKey("sk-legacy-one")).toBe(true);
  });

  it("export/import round-trips groups and membership", async () => {
    const { db } = await boot();
    const lab = await db.createApiKeyGroup("Lab");
    const key = await db.createApiKey("k", "machine-1");
    await db.updateApiKey(key.id, { groupId: lab.id });

    const dump = await db.exportDb();
    expect(dump.apiKeyGroups).toEqual([{ id: lab.id, name: "Lab", createdAt: lab.createdAt }]);
    await db.deleteApiKeyGroup(lab.id);

    await db.importDb(dump);
    expect((await db.getApiKeyGroups()).map((g) => g.name)).toEqual(["Lab"]);
    expect((await db.getApiKeyById(key.id)).groupId).toBe(lab.id);
  });

  it("import without groups, or with a dangling groupId, restores keys ungrouped", async () => {
    const { db } = await boot();
    const key = await db.createApiKey("k", "machine-1");
    const dump = await db.exportDb();

    const older = { ...dump };
    delete older.apiKeyGroups;
    older.apiKeys = older.apiKeys.map(({ groupId, ...rest }) => rest);
    await db.importDb(older);
    expect((await db.getApiKeyById(key.id)).groupId).toBeNull();

    const dangling = { ...dump, apiKeyGroups: [], apiKeys: dump.apiKeys.map((k) => ({ ...k, groupId: "ghost" })) };
    await db.importDb(dangling);
    expect((await db.getApiKeyById(key.id)).groupId).toBeNull();
  });
});
