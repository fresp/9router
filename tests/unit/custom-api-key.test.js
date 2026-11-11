// User-defined API keys: validation rules, repo create (custom vs generated,
// duplicate rejection) and the POST /api/keys contract.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { validateCustomApiKey } from "@/shared/utils/customApiKey.js";

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: vi.fn(async () => "machine0123456789"),
}));

let tempDir;
const originalDataDir = process.env.DATA_DIR;

async function boot() {
  delete global._dbAdapter;
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  const route = await import("@/app/api/keys/route.js");
  return { db, route };
}

function post(body) {
  return new Request("http://localhost/api/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-custom-key-"));
  process.env.DATA_DIR = tempDir;
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("validateCustomApiKey", () => {
  it("accepts a short sk- key and flags it weak", () => {
    expect(validateCustomApiKey("  sk-fresp-lab ")).toEqual({ ok: true, value: "sk-fresp-lab", weak: true });
  });

  it("does not flag a long key as weak", () => {
    const r = validateCustomApiKey("sk-" + "a".repeat(30));
    expect(r.ok).toBe(true);
    expect(r.weak).toBe(false);
  });

  it.each([
    ["missing prefix", "fresp-lab-key"],
    ["bad charset", "sk-fresp lab"],
    ["header injection", "sk-fresp\r\nX-Evil: 1"],
    ["too short", "sk-abc"],
    ["too long", "sk-" + "a".repeat(130)],
    ["non-string", 12345678],
  ])("rejects %s", (_label, input) => {
    expect(validateCustomApiKey(input).ok).toBe(false);
  });
});

describe("createApiKey with a custom key", () => {
  it("stores the exact key and authenticates with it", async () => {
    const { db } = await boot();
    const created = await db.createApiKey("lab", "machine-1", "sk-fresp-lab");
    expect(created.key).toBe("sk-fresp-lab");
    expect(await db.validateApiKey("sk-fresp-lab")).toBe(true);
    expect((await db.getApiKeyByKey("sk-fresp-lab")).access).toEqual({ restricted: false, allow: [] });
  });

  it("still generates a machine-bound key when none is given", async () => {
    const { db } = await boot();
    const created = await db.createApiKey("auto", "machine-1");
    expect(created.key).toMatch(/^sk-machine-1-[a-z0-9]{6}-[0-9a-f]{8}$/);
  });

  it("rejects a duplicate key and keeps the original row", async () => {
    const { db } = await boot();
    await db.createApiKey("first", "machine-1", "sk-fresp-lab");
    await expect(db.createApiKey("second", "machine-1", "sk-fresp-lab")).rejects.toMatchObject({ code: "API_KEY_EXISTS" });
    const keys = await db.getApiKeys();
    expect(keys.map((k) => k.name)).toEqual(["first"]);
  });
});

describe("POST /api/keys", () => {
  it("creates a custom key", async () => {
    const { db, route } = await boot();
    const res = await route.POST(post({ name: "lab", key: "sk-fresp-lab" }));
    expect(res.status).toBe(201);
    expect((await res.json()).key).toBe("sk-fresp-lab");
    expect(await db.validateApiKey("sk-fresp-lab")).toBe(true);
  });

  it("generates a key when key is empty or absent", async () => {
    const { route } = await boot();
    for (const body of [{ name: "a" }, { name: "b", key: "" }]) {
      const res = await route.POST(post(body));
      expect(res.status).toBe(201);
      expect((await res.json()).key).toMatch(/^sk-machine0123456789-/);
    }
  });

  it("returns 400 for an invalid key and stores nothing", async () => {
    const { db, route } = await boot();
    const res = await route.POST(post({ name: "bad", key: "fresp lab" }));
    expect(res.status).toBe(400);
    expect(await db.getApiKeys()).toEqual([]);
  });

  it("returns 409 for a duplicate key", async () => {
    const { route } = await boot();
    await route.POST(post({ name: "first", key: "sk-fresp-lab" }));
    const res = await route.POST(post({ name: "second", key: "sk-fresp-lab" }));
    expect(res.status).toBe(409);
  });
});
