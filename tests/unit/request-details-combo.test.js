// Request details record the combo a request was routed through, so the Usage
// "Details" tab can show which combo picked the model.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildRequestDetail } from "open-sse/handlers/chatCore/requestDetail.js";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
const originalRequestLogs = process.env.ENABLE_REQUEST_LOGS;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-detail-combo-"));
  process.env.DATA_DIR = tempDir;
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

const base = { provider: "midas", model: "glm-5.3-flash", request: { headers: {} } };

describe("request details: combo", () => {
  it("takes combo and nested hop from the client raw request, not the raw request itself", () => {
    const d = buildRequestDetail({ ...base, clientRawRequest: { combo: "dpe", comboVia: "inner", headers: { authorization: "x" } } });
    expect(d.combo).toBe("dpe");
    expect(d.comboVia).toBe("inner");
    expect(d).not.toHaveProperty("clientRawRequest");
  });

  it("leaves combo unset for a direct model request", () => {
    const d = buildRequestDetail({ ...base, clientRawRequest: { endpoint: "/v1/chat/completions" } });
    expect(d.combo).toBeUndefined();
    expect(d.comboVia).toBeUndefined();
  });

  it("persists combo through the repo", async () => {
    delete global._dbAdapter;
    vi.resetModules();
    const repo = await import("@/lib/db/repos/requestDetailsRepo.js");
    await repo.saveRequestDetail(buildRequestDetail({ ...base, clientRawRequest: { combo: "dpe" } }, { id: "d1" }));
    await repo.__test__.flush();
    const saved = await repo.getRequestDetailById("d1");
    expect(saved.combo).toBe("dpe");
    expect(saved.comboVia).toBeUndefined();
  });
});
