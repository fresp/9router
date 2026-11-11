"use client";

// "Groups" tab on the Endpoint page. A group is only an organizing container
// for API keys: it carries no access rules of its own and never affects how a
// /v1 request is authenticated or routed. Its bulk actions (enable/pause, set
// access) write to the member keys. A key belongs to at most one group, so
// adding a key that already has a group moves it.
import { useState } from "react";
import PropTypes from "prop-types";
import { Button, Input, Toggle } from "@/shared/components";
import { validateKeyGroupName, KEY_GROUP_NAME_MAX_LENGTH } from "@/shared/utils/apiKeyGroup.js";
import KeyAccessControls from "./KeyAccessControls";

const allowSignature = (access) =>
  access?.restricted ? (access.allow || []).map((e) => e.toLowerCase()).sort().join("\n") : null;

/**
 * Summarize the access of a group's keys. `uniform` is true when every key has
 * the same settings. `access` is the starting point for the bulk editor: the
 * shared settings, or for a mixed group only what every restricted key already
 * allows, so applying an untouched draft can narrow access but never widen it.
 */
function summarizeGroupAccess(members) {
  const signatures = new Set(members.map((k) => allowSignature(k.access)));
  const restricted = members.filter((k) => k.access?.restricted);
  if (signatures.size <= 1) {
    const first = members[0]?.access;
    const access = first?.restricted ? { restricted: true, allow: [...(first.allow || [])] } : { restricted: false, allow: [] };
    return { uniform: true, access, label: access.restricted ? `Restricted · ${access.allow.length}` : "Unrestricted" };
  }
  const common = (restricted[0]?.access.allow || []).filter((entry) =>
    restricted.every((k) => k.access.allow.some((e) => e.toLowerCase() === entry.toLowerCase()))
  );
  return { uniform: false, access: { restricted: true, allow: common }, label: "Mixed access" };
}

export default function KeyGroupsPanel({ groups, keys, onCreate, onDelete, onSetKeyGroup, onToggleGroup, onSetGroupAccess }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [collapsed, setCollapsed] = useState(() => new Set());
  // Bulk access editor: one group at a time, nothing is saved until Apply.
  const [editing, setEditing] = useState(null);
  const [applying, setApplying] = useState(false);

  const applyAccess = async (group) => {
    setApplying(true);
    const result = await onSetGroupAccess(group, editing.access);
    setApplying(false);
    if (result?.ok) setEditing(null);
    else setEditing((prev) => (prev ? { ...prev, error: result?.error || "Failed to update access" } : prev));
  };

  const groupNameById = new Map(groups.map((g) => [g.id, g.name]));

  const submit = async (e) => {
    e.preventDefault();
    const checked = validateKeyGroupName(name);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    const result = await onCreate(checked.value);
    if (result?.ok) {
      setName("");
      setError("");
    } else {
      setError(result?.error || "Failed to create group");
    }
  };

  const toggleCollapsed = (id) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-4" data-testid="key-groups">
      <form onSubmit={submit} className="flex items-start gap-2">
        <Input
          className="flex-1"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError("");
          }}
          placeholder="New group name"
          maxLength={KEY_GROUP_NAME_MAX_LENGTH}
          aria-label="New group name"
          autoComplete="off"
          error={error || undefined}
        />
        <Button type="submit" variant="secondary" icon="add">
          New Group
        </Button>
      </form>

      {groups.length === 0 ? (
        <p className="text-sm text-text-muted py-6 text-center">
          No groups yet. Create one to start organizing keys.
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {groups.map((group) => {
            const members = keys.filter((k) => k.groupId === group.id);
            const others = keys.filter((k) => k.groupId !== group.id);
            const open = !collapsed.has(group.id);
            const summary = summarizeGroupAccess(members);
            const draft = editing?.groupId === group.id ? editing : null;
            return (
              <div
                key={group.id}
                className="rounded-[12px] border border-border-subtle bg-bg-alt min-w-0 self-start"
                data-testid="key-group"
              >
                <div className="flex items-center gap-2 px-3 py-2 flex-wrap">
                  <button
                    type="button"
                    onClick={() => toggleCollapsed(group.id)}
                    aria-expanded={open}
                    className="flex items-center gap-1 flex-1 min-w-0 text-left text-sm font-semibold rounded hover:text-primary transition-colors"
                  >
                    <span className="material-symbols-outlined text-[18px] text-text-muted">
                      {open ? "expand_more" : "chevron_right"}
                    </span>
                    <span className="break-words min-w-0">{group.name}</span>
                  </button>
                  <span className="text-xs text-text-muted bg-surface-2 rounded-full px-2 py-0.5">
                    {members.length} {members.length === 1 ? "key" : "keys"}
                  </span>
                  {members.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setEditing(draft ? null : { groupId: group.id, access: summary.access, error: "" })}
                      aria-expanded={Boolean(draft)}
                      title={`Set access for all keys in ${group.name}`}
                      className={`flex items-center gap-1 text-xs rounded-full px-2 py-0.5 transition-colors hover:text-primary ${summary.uniform ? "text-text-muted bg-surface-2" : "text-orange-500 bg-orange-500/10"}`}
                    >
                      <span className="material-symbols-outlined text-[14px]">
                        {summary.uniform && !summary.access.restricted ? "lock_open" : "lock"}
                      </span>
                      {summary.label}
                    </button>
                  )}
                  {members.length > 0 && (
                    <span className="flex items-center gap-1.5 text-xs text-text-muted">
                      All
                      <Toggle
                        size="sm"
                        checked={members.every((k) => k.isActive !== false)}
                        onChange={(checked) => onToggleGroup(group, checked)}
                        title={`Enable or pause all keys in ${group.name}`}
                      />
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => onDelete(group)}
                    title={`Delete group ${group.name}`}
                    aria-label={`Delete group ${group.name}`}
                    className="p-1 hover:bg-red-500/10 rounded text-red-500 transition-all"
                  >
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                  </button>
                </div>

                {draft && members.length > 0 && (
                  <div className="px-3 pb-3 border-t border-border-subtle" data-testid="key-group-access">
                    <p className="text-xs text-text-muted mt-2">
                      Access for all {members.length} {members.length === 1 ? "key" : "keys"} in this group. Nothing changes until you apply.
                    </p>
                    {!summary.uniform && (
                      <p className="text-xs text-orange-500 mt-1">
                        These keys currently have different access. Applying overwrites every key; the list starts from what all restricted keys already share.
                      </p>
                    )}
                    <KeyAccessControls
                      apiKey={{ id: group.id, name: group.name, access: draft.access }}
                      onChange={(access) => setEditing({ groupId: group.id, access, error: "" })}
                      onRequestRestrict={() => setEditing({ groupId: group.id, access: { restricted: true, allow: draft.access.allow }, error: "" })}
                    />
                    {draft.error && <p className="text-xs text-red-500 mt-2">{draft.error}</p>}
                    <div className="flex items-center gap-2 mt-3">
                      <Button size="sm" onClick={() => applyAccess(group)} disabled={applying}>
                        Apply to {members.length} {members.length === 1 ? "key" : "keys"}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setEditing(null)} disabled={applying}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}

                {open && (
                  <div className="flex flex-wrap items-center gap-1.5 px-3 py-3 border-t border-border-subtle">
                    {members.length === 0 && <span className="text-xs text-text-muted">No keys yet.</span>}
                    {members.map((k) => (
                      <span
                        key={k.id}
                        className="inline-flex items-center gap-1 max-w-full text-xs bg-surface-2 rounded-full pl-2.5 pr-1 py-0.5"
                      >
                        <span className={`break-all ${k.isActive === false ? "line-through text-text-muted" : ""}`}>
                          {k.name}
                        </span>
                        <button
                          type="button"
                          onClick={() => onSetKeyGroup(k.id, null)}
                          title={`Remove ${k.name} from ${group.name}`}
                          aria-label={`Remove ${k.name} from ${group.name}`}
                          className="flex items-center justify-center size-5 rounded-full text-text-muted hover:text-red-500 transition-colors"
                        >
                          <span className="material-symbols-outlined text-[14px]">close</span>
                        </button>
                      </span>
                    ))}
                    {others.length > 0 && (
                      <select
                        value=""
                        onChange={(e) => e.target.value && onSetKeyGroup(e.target.value, group.id)}
                        aria-label={`Add key to ${group.name}`}
                        className="text-xs text-text-main bg-surface-2 rounded-lg px-2 py-1 max-w-[180px] focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                      >
                        <option value="">+ Add key</option>
                        {others.map((k) => (
                          <option key={k.id} value={k.id}>
                            {k.groupId && groupNameById.has(k.groupId)
                              ? `${k.name} (from ${groupNameById.get(k.groupId)})`
                              : k.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

KeyGroupsPanel.propTypes = {
  groups: PropTypes.arrayOf(PropTypes.shape({ id: PropTypes.string.isRequired, name: PropTypes.string.isRequired })).isRequired,
  keys: PropTypes.array.isRequired,
  onCreate: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired,
  onSetKeyGroup: PropTypes.func.isRequired,
  onToggleGroup: PropTypes.func.isRequired,
  onSetGroupAccess: PropTypes.func.isRequired,
};
