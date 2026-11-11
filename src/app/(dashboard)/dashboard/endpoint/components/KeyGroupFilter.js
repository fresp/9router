"use client";

// Group filter for the "API Keys" tab on the Endpoint page. View-only: it
// narrows the list shown and never changes a key.
import PropTypes from "prop-types";

export const KEY_GROUP_FILTER_ALL = "all";
export const KEY_GROUP_FILTER_NONE = "none";

const isUngrouped = (key, groups) => !groups.some((g) => g.id === key.groupId);

/** A filter left pointing at a deleted group falls back to "all". */
export function resolveKeyGroupFilter(filter, groups) {
  return filter === KEY_GROUP_FILTER_NONE || groups.some((g) => g.id === filter) ? filter : KEY_GROUP_FILTER_ALL;
}

export function filterKeysByGroup(keys, groups, filter) {
  const active = resolveKeyGroupFilter(filter, groups);
  if (active === KEY_GROUP_FILTER_ALL) return keys;
  if (active === KEY_GROUP_FILTER_NONE) return keys.filter((k) => isUngrouped(k, groups));
  return keys.filter((k) => k.groupId === active);
}

export default function KeyGroupFilter({ groups, keys, value, onChange }) {
  if (groups.length === 0) return <span />;
  return (
    <label className="flex items-center gap-2 text-xs text-text-muted">
      Group
      <select
        value={resolveKeyGroupFilter(value, groups)}
        onChange={(e) => onChange(e.target.value)}
        className="text-sm text-text-main bg-surface-2 rounded-lg px-2 py-1.5 max-w-[200px] focus:outline-none focus:ring-2 focus:ring-brand-500/30"
      >
        <option value={KEY_GROUP_FILTER_ALL}>All keys ({keys.length})</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name} ({keys.filter((k) => k.groupId === g.id).length})
          </option>
        ))}
        <option value={KEY_GROUP_FILTER_NONE}>Ungrouped ({keys.filter((k) => isUngrouped(k, groups)).length})</option>
      </select>
    </label>
  );
}

KeyGroupFilter.propTypes = {
  groups: PropTypes.arrayOf(PropTypes.shape({ id: PropTypes.string.isRequired, name: PropTypes.string.isRequired })).isRequired,
  keys: PropTypes.array.isRequired,
  value: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
};
