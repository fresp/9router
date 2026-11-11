"use client";

// "Groups" tab on the Endpoint page. A group is only an organizing container
// for API keys: it carries no access rules and never affects how a /v1 request
// is authenticated or routed. A key belongs to at most one group, so adding a
// key that already has a group moves it.
import { useState } from "react";
import PropTypes from "prop-types";
import { Button, Input, Toggle } from "@/shared/components";
import { validateKeyGroupName, KEY_GROUP_NAME_MAX_LENGTH } from "@/shared/utils/apiKeyGroup.js";

export default function KeyGroupsPanel({ groups, keys, onCreate, onDelete, onSetKeyGroup, onToggleGroup }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [collapsed, setCollapsed] = useState(() => new Set());

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
};
