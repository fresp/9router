"use client";

import { useState, useEffect, useMemo } from "react";
import PropTypes from "prop-types";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import Card from "@/shared/components/Card";

const fmtTokens = (n) => {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n || 0));
};
const fmtCost = (n) => `$${(n || 0).toFixed(2)}`;
const fmtRequests = (n) => new Intl.NumberFormat().format(n || 0);

// Hourly buckets carry their start time; label them in the viewer's timezone.
const fmtHour = (ts) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });

const VIEW_MODES = [
  { value: "tokens", label: "Tokens", formatter: fmtTokens },
  { value: "requests", label: "Requests", formatter: fmtRequests },
  { value: "cost", label: "Cost", formatter: fmtCost },
];

// One slot per key series, in server rank order; "Other" is always neutral.
// Light / dark steps are set as CSS variables on the card (see SERIES_VARS).
const SERIES_COLORS = ["var(--ak-1)", "var(--ak-2)", "var(--ak-3)", "var(--ak-4)", "var(--ak-5)"];
const OTHER_COLOR = "var(--ak-other)";
const SERIES_VARS = [
  "[--ak-1:#2a78d6] dark:[--ak-1:#3987e5]",
  "[--ak-2:#eb6834] dark:[--ak-2:#d95926]",
  "[--ak-3:#1baf7a] dark:[--ak-3:#199e70]",
  "[--ak-4:#eda100] dark:[--ak-4:#c98500]",
  "[--ak-5:#e87ba4] dark:[--ak-5:#d55181]",
  "[--ak-other:#9ca3af] dark:[--ak-other:#6b7280]",
].join(" ");

const PERIOD_LABEL = {
  today: "today · hourly",
  "24h": "last 24 hours · hourly",
  "7d": "last 7 days · daily",
  "30d": "last 30 days · daily",
  "60d": "last 60 days · daily",
  all: "all time · daily",
};

export default function ApiKeyUsageChart({ period = "7d" }) {
  const [data, setData] = useState({ labels: [], series: [], keyCount: 0 });
  // Loading is derived: true until the fetch for the current period settles.
  const [loadedPeriod, setLoadedPeriod] = useState(null);
  const loading = loadedPeriod !== period;
  const [viewMode, setViewMode] = useState("tokens");
  const [hidden, setHidden] = useState({});

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/usage/chart?period=${period}&groupBy=apiKey&tzOffset=${new Date().getTimezoneOffset()}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!cancelled && json && Array.isArray(json.series)) {
          setData(Array.isArray(json.timestamps) ? { ...json, labels: json.timestamps.map(fmtHour) } : json);
        }
      })
      .catch((e) => console.error("Failed to fetch API key chart data:", e))
      .finally(() => {
        if (!cancelled) setLoadedPeriod(period);
      });
    return () => {
      cancelled = true;
    };
  }, [period]);

  const mode = VIEW_MODES.find((m) => m.value === viewMode);

  // Color follows the series slot, so hiding one never repaints the others.
  const series = useMemo(
    () => data.series.map((s, i) => ({
      ...s,
      dataKey: `s${i}`,
      color: s.isOther ? OTHER_COLOR : SERIES_COLORS[i % SERIES_COLORS.length],
    })),
    [data.series],
  );

  const rows = useMemo(
    () => data.labels.map((label, i) => {
      const row = { label };
      for (const s of series) row[s.dataKey] = s[viewMode]?.[i] || 0;
      return row;
    }),
    [data.labels, series, viewMode],
  );

  const grandTotal = series.reduce((a, s) => a + (s.totals?.[viewMode] || 0), 0);
  const visible = series.filter((s) => !hidden[s.id]);
  const hasData = grandTotal > 0;
  const topSeries = visible[visible.length - 1];

  return (
    <Card className={`flex min-w-0 flex-col gap-3 p-3 sm:p-4 ${SERIES_VARS}`}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col">
          <span className="text-sm font-semibold text-text-muted uppercase tracking-wide">Usage by API key</span>
          <span className="text-xs text-text-muted">
            {data.keyCount} {data.keyCount === 1 ? "key" : "keys"} · {PERIOD_LABEL[period] || period}
          </span>
        </div>
        <div
          className="grid w-full items-center gap-1 rounded-lg border border-border bg-bg-subtle p-1 sm:w-auto"
          style={{ gridTemplateColumns: `repeat(${VIEW_MODES.length}, minmax(0, 1fr))` }}
        >
          {VIEW_MODES.map((m) => (
            <button
              key={m.value}
              onClick={() => setViewMode(m.value)}
              aria-pressed={viewMode === m.value}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${viewMode === m.value ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text hover:bg-bg-hover"}`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="h-56 flex items-center justify-center text-text-muted text-sm">Loading...</div>
      ) : !hasData ? (
        <div className="h-56 flex items-center justify-center text-text-muted text-sm">No API key usage for this period</div>
      ) : (
        <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start">
          <div className="min-w-0 flex-1">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.1} vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
                  tickLine={false}
                  axisLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={mode.formatter}
                  width={50}
                />
                <Tooltip
                  cursor={{ fill: "currentColor", fillOpacity: 0.06 }}
                  contentStyle={{
                    backgroundColor: "var(--color-bg)",
                    border: "1px solid var(--color-border)",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                  itemStyle={{ color: "var(--color-text)" }}
                  formatter={(value, name) => [mode.formatter(value), name]}
                  itemSorter={(item) => -visible.findIndex((s) => s.dataKey === item.dataKey)}
                />
                {visible.map((s) => (
                  <Bar
                    key={s.dataKey}
                    dataKey={s.dataKey}
                    name={s.name}
                    stackId="keys"
                    fill={s.color}
                    stroke="var(--color-surface)"
                    strokeWidth={1}
                    radius={s === topSeries ? [3, 3, 0, 0] : 0}
                    isAnimationActive={false}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="flex min-w-0 flex-col gap-0.5 lg:w-72 lg:shrink-0">
            <div className="flex justify-between px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
              <span>API key</span>
              <span>{mode.label}</span>
            </div>
            {series.map((s) => {
              const total = s.totals?.[viewMode] || 0;
              const off = !!hidden[s.id];
              return (
                <button
                  key={s.dataKey}
                  onClick={() => setHidden((h) => ({ ...h, [s.id]: !h[s.id] }))}
                  aria-pressed={!off}
                  title={off ? "Show in chart" : "Hide from chart"}
                  className={`flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-bg-hover ${off ? "opacity-40" : ""}`}
                >
                  <span className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: s.color }} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">
                      {s.name}
                      {s.group && <span className="ml-1.5 text-xs font-normal text-text-muted">{s.group}</span>}
                    </span>
                    {s.masked && s.masked !== s.name && (
                      <span className="truncate font-mono text-[11px] text-text-muted">{s.masked}</span>
                    )}
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums">{mode.formatter(total)}</span>
                  <span className="w-12 shrink-0 text-right text-xs tabular-nums text-text-muted">
                    {grandTotal > 0 ? `${((total / grandTotal) * 100).toFixed(1)}%` : "—"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}

ApiKeyUsageChart.propTypes = {
  period: PropTypes.string,
};
