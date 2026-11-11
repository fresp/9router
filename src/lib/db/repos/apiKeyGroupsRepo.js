// API key groups: organizing containers for API keys. A key belongs to at most
// one group (apiKeys.groupId). Groups carry no access rules.
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

// Thrown when a group name is already taken (case-insensitive).
export const API_KEY_GROUP_EXISTS = "API_KEY_GROUP_EXISTS";

function rowToGroup(row) {
  if (!row) return null;
  return { id: row.id, name: row.name, createdAt: row.createdAt };
}

export async function getApiKeyGroups() {
  const db = await getAdapter();
  return db.all(`SELECT * FROM apiKeyGroups ORDER BY createdAt ASC`).map(rowToGroup);
}

export async function getApiKeyGroupById(id) {
  if (!id) return null;
  const db = await getAdapter();
  return rowToGroup(db.get(`SELECT * FROM apiKeyGroups WHERE id = ?`, [id]));
}

/** Create a group. `name` is already validated by the caller. */
export async function createApiKeyGroup(name) {
  const db = await getAdapter();
  const group = { id: uuidv4(), name, createdAt: new Date().toISOString() };
  let exists = false;
  db.transaction(() => {
    if (db.get(`SELECT id FROM apiKeyGroups WHERE LOWER(name) = LOWER(?)`, [name])) {
      exists = true;
      return;
    }
    db.run(`INSERT INTO apiKeyGroups(id, name, createdAt) VALUES(?, ?, ?)`, [group.id, group.name, group.createdAt]);
  });
  if (exists) {
    const err = new Error("API key group already exists");
    err.code = API_KEY_GROUP_EXISTS;
    throw err;
  }
  return group;
}

/**
 * Delete a group. Its keys are kept and become ungrouped; their active state
 * and access settings are untouched.
 */
export async function deleteApiKeyGroup(id) {
  const db = await getAdapter();
  let deleted = false;
  db.transaction(() => {
    db.run(`UPDATE apiKeys SET groupId = NULL WHERE groupId = ?`, [id]);
    const res = db.run(`DELETE FROM apiKeyGroups WHERE id = ?`, [id]);
    deleted = (res?.changes ?? 0) > 0;
  });
  return deleted;
}

/** Enable or pause every key in a group. Returns the number of keys in it. */
export async function setApiKeyGroupActive(id, isActive) {
  const db = await getAdapter();
  let count = 0;
  db.transaction(() => {
    db.run(`UPDATE apiKeys SET isActive = ? WHERE groupId = ?`, [isActive ? 1 : 0, id]);
    count = db.get(`SELECT COUNT(*) AS n FROM apiKeys WHERE groupId = ?`, [id])?.n ?? 0;
  });
  return count;
}
