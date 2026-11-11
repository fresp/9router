import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { keyAccessFromColumns, keyAccessToColumns } from "@/shared/utils/keyAccess.js";
import { KEY_ACCESS_UNRESTRICTED } from "@/shared/constants/keyAccess.js";

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    access: keyAccessFromColumns(row.accessRestricted, row.accessAllow),
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

// Used by the /v1 handlers to read the presented key's access settings.
export async function getApiKeyByKey(key) {
  if (!key) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
  return rowToKey(row);
}

// Thrown by createApiKey when a custom key is already taken.
export const API_KEY_EXISTS = "API_KEY_EXISTS";

/**
 * Create an API key. With `customKey` (already validated by the caller) that
 * exact string is stored; otherwise a random machine-bound key is generated.
 */
export async function createApiKey(name, machineId, customKey) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  let key = customKey;
  if (!key) {
    const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
    key = generateApiKeyWithMachine(machineId).key;
  }
  const apiKey = {
    id: uuidv4(),
    name,
    key,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
    access: { restricted: false, allow: [] },
  };
  const cols = keyAccessToColumns(KEY_ACCESS_UNRESTRICTED);
  let exists = false;
  db.transaction(() => {
    if (db.get(`SELECT id FROM apiKeys WHERE key = ?`, [apiKey.key])) {
      exists = true;
      return;
    }
    db.run(
      `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, accessRestricted, accessAllow) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt, cols.accessRestricted, cols.accessAllow]
    );
  });
  if (exists) {
    const err = new Error("API key already exists");
    err.code = API_KEY_EXISTS;
    throw err;
  }
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    const cols = keyAccessToColumns(merged.access);
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, accessRestricted = ?, accessAllow = ? WHERE id = ?`,
      [merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0, cols.accessRestricted, cols.accessAllow, id]
    );
    result = rowToKey(db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]));
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT isActive FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}
