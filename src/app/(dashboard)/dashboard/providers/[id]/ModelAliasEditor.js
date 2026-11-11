"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { validateModelAliasName } from "@/shared/utils/modelAlias";

// Alias chips + inline "add alias" input for one model row. An alias is a bare
// name clients can send as `model` instead of `provider/model`.
export default function ModelAliasEditor({ aliases, onAdd, onRemove, copied, onCopy }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const close = () => {
    setEditing(false);
    setValue("");
    setError("");
  };

  const save = async () => {
    if (saving) return;
    const name = value.trim();
    const invalid = validateModelAliasName(name);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    try {
      const failure = await onAdd(name);
      if (failure) setError(failure);
      else close();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {aliases.map((alias) => (
          <span
            key={alias}
            className="inline-flex max-w-full items-center gap-0.5 rounded bg-primary/10 py-0.5 pl-1.5 pr-0.5 font-mono text-[11px] text-primary"
          >
            <button
              type="button"
              onClick={() => onCopy?.(alias, `alias-${alias}`)}
              className="inline-flex min-w-0 items-center gap-1"
              title="Copy alias"
            >
              <span className="material-symbols-outlined text-[12px]">
                {copied === `alias-${alias}` ? "check" : "label"}
              </span>
              <span className="truncate">{alias}</span>
            </button>
            <button
              type="button"
              onClick={() => onRemove(alias)}
              className="rounded p-0.5 hover:bg-red-500/10 hover:text-red-500"
              title="Remove alias"
              aria-label={`Remove alias ${alias}`}
            >
              <span className="material-symbols-outlined block text-[12px]">close</span>
            </button>
          </span>
        ))}

        {editing ? (
          <span className="inline-flex items-center gap-1">
            <input
              autoFocus
              type="text"
              value={value}
              onChange={(e) => { setValue(e.target.value); setError(""); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                if (e.key === "Escape") close();
              }}
              placeholder="alias-name"
              aria-label="Alias name"
              className="w-40 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[11px] focus:border-primary focus:outline-none"
            />
            <button
              type="button"
              onClick={save}
              disabled={saving || !value.trim()}
              className="rounded p-0.5 text-text-muted hover:bg-sidebar hover:text-primary disabled:opacity-40"
              title="Save alias"
            >
              <span className="material-symbols-outlined block text-sm">check</span>
            </button>
            <button
              type="button"
              onClick={close}
              className="rounded p-0.5 text-text-muted hover:bg-sidebar hover:text-primary"
              title="Cancel"
            >
              <span className="material-symbols-outlined block text-sm">close</span>
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="inline-flex items-center gap-0.5 rounded border border-dashed border-border px-1.5 py-0.5 text-[11px] text-text-muted hover:border-primary hover:text-primary"
            title="Add an alias clients can use instead of provider/model"
          >
            <span className="material-symbols-outlined text-[12px]">add</span>
            Alias
          </button>
        )}
      </div>
      {error && <p className="text-[11px] text-red-500">{error}</p>}
    </div>
  );
}

ModelAliasEditor.propTypes = {
  aliases: PropTypes.arrayOf(PropTypes.string).isRequired,
  onAdd: PropTypes.func.isRequired,
  onRemove: PropTypes.func.isRequired,
  copied: PropTypes.string,
  onCopy: PropTypes.func,
};
