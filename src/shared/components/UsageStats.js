"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { FREE_PROVIDERS, AI_PROVIDERS } from "@/shared/constants/providers";

// Keep providers without serviceKinds (default LLM) or with "llm" in serviceKinds
function isLLMProvider(id) {
  const p = AI_PROVIDERS[id];
  if (!p?.serviceKinds) return true;
  return p.serviceKinds.includes("llm");
}
import Badge from "./Badge";
import Card from "./Card";
import SegmentedControl from "./SegmentedControl";
import OverviewCards from "@/app/(dashboard)/dashboard/usage/components/OverviewCards";
import UsageTable, { fmt, fmtTime } from "@/app/(dashboard)/dashboard/usage/components/UsageTable";
import dynamic from "next/dynamic";
// Lazy-load: keeps @xyflow/react and recharts out of the initial bundle
const ProviderTopology = dynamic(() => import("@/app/(dashboard)/dashboard/usage/components/ProviderTopology"), { ssr: false });
const UsageChart = dynamic(() => import("@/app/(dashboard)/dashboard/usage/components/UsageChart"), { ssr: false });
const ProviderBarChart = dynamic(() => import("@/app/(dashboard)/dashboard/usage/components/ProviderBarChart"), { ssr: false });
const ApiKeyUsageChart = dynamic(() => import("@/app/(dashboard)/dashboard/usage/components/ApiKeyUsageChart"), { ssr: false });
const TopModelsChart = dynamic(() => import("@/app/(dashboard)/dashboard/usage/components/TopModelsChart"), { ssr: false });

function timeAgo(timestamp) {
  const diff = Math.floor((Date.now() - new Date(timestamp)) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// Auto-update time display every second without re-rendering parent
function TimeAgo({ timestamp }) {
  const [, setTick] = useState(0);
  
  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  
  return <>{timeAgo(timestamp)}</>;
}

function RecentRequests({ requests = [] }) {
  return (
    <Card className="flex min-w-0 flex-col overflow-hidden" padding="sm" style={{ height: 480 }}>
      {/* Header */}
      <div className="px-1 py-2 border-b border-border shrink-0">
        <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">Recent Requests</span>
      </div>

      {!requests.length ? (
        <div className="flex-1 flex items-center justify-center text-text-muted text-sm">No requests yet.</div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <table className="w-full min-w-[300px] border-collapse text-xs">
            <thead className="sticky top-0 bg-bg z-10">
              <tr className="border-b border-border">
                <th className="py-1.5 text-left font-semibold text-text-muted w-2"></th>
                <th className="py-1.5 text-left font-semibold text-text-muted">Model</th>
                <th className="py-1.5 text-right font-semibold text-text-muted whitespace-nowrap">In / Out</th>
                <th className="py-1.5 text-right font-semibold text-text-muted">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {requests.map((r, i) => {
                const ok = !r.status || r.status === "ok" || r.status === "success";
                return (
                  <tr key={i} className="hover:bg-bg-subtle transition-colors">
                    <td className="py-1.5">
                      <span className={`block w-1.5 h-1.5 rounded-full ${ok ? "bg-success" : "bg-error"}`} />
                    </td>
                    <td className="py-1.5 font-mono truncate max-w-[120px]" title={r.model}>{r.model}</td>
                    <td className="py-1.5 text-right whitespace-nowrap">
                      <span className="text-primary">{fmt(r.promptTokens)}↑</span>
                      {" "}
                      <span className="text-success">{fmt(r.completionTokens)}↓</span>
                    </td>
                    <td className="py-1.5 text-right text-text-muted whitespace-nowrap"><TimeAgo timestamp={r.timestamp} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function sortData(dataMap, pendingMap = {}, sortBy, sortOrder) {
  return Object.entries(dataMap || {})
    .map(([key, data]) => {
      const totalTokens = (data.promptTokens || 0) + (data.completionTokens || 0);
      const totalCost = data.cost || 0;
      // Cost split: the server sends a per-rate split (inputCost / cachedCost /
      // outputCost) for everything it could price that way. Whatever part of the
      // total it does not cover (rollups recorded before the split existed) is
      // spread by token share, so the three columns always sum to the total.
      const cachedTokens = data.cachedTokens || 0;
      const nonCachedInput = Math.max(0, (data.promptTokens || 0) - cachedTokens);
      const rated = (data.inputCost || 0) + (data.cachedCost || 0) + (data.outputCost || 0);
      const perToken = totalTokens > 0 ? Math.max(0, totalCost - rated) / totalTokens : 0;
      const inputCost = (data.inputCost || 0) + nonCachedInput * perToken;
      const cachedCost = (data.cachedCost || 0) + cachedTokens * perToken;
      const outputCost = (data.outputCost || 0) + (data.completionTokens || 0) * perToken;
      return { ...data, key, totalTokens, totalCost, inputCost, cachedCost, outputCost, pending: pendingMap[key] || 0 };
    })
    .sort((a, b) => {
      let valA = a[sortBy];
      let valB = b[sortBy];
      if (typeof valA === "string") valA = valA.toLowerCase();
      if (typeof valB === "string") valB = valB.toLowerCase();
      if (valA < valB) return sortOrder === "asc" ? -1 : 1;
      if (valA > valB) return sortOrder === "asc" ? 1 : -1;
      return 0;
    });
}

const DIRECT_COMBO_LABEL = "Direct (no combo)";

// Router statistics of one combo: how the first model was picked, and how many
// requests were served by a later member after the first choice failed.
// Why the router gave no decision, as recorded by resolveSmartChoice / handleComboChat
const ROUTER_FAIL_LABELS = {
  http_429: "rate limited (429)",
  timeout: "timeout",
  no_prompt: "no prompt text",
  no_credentials: "no credentials",
  router_model_unknown: "unknown router model",
  invalid_response: "invalid response",
  invalid_choice: "choice not a member",
  upstream_error: "upstream error",
  no_decision: "no decision",
  error: "error",
};

function routerFailLabel(reason) {
  if (ROUTER_FAIL_LABELS[reason]) return ROUTER_FAIL_LABELS[reason];
  const http = /^http_(\d{3})$/.exec(reason);
  return http ? `HTTP ${http[1]}` : reason;
}

function ComboRouterStats({ router }) {
  const decided = (router?.routed || 0) + (router?.kept || 0) + (router?.lowConfidence || 0) + (router?.routerFailed || 0) + (router?.defaulted || 0);
  const failReasons = Object.entries(router?.failReasons || {}).sort((a, b) => b[1] - a[1]);
  const failover = router?.failover || 0;
  if (!decided && !failover) return <span className="text-text-muted">—</span>;
  const pct = (n) => `${Math.round((n / decided) * 100)}%`;
  const avgConfidence = router.confidenceCount > 0 ? (router.confidenceSum / router.confidenceCount).toFixed(2) : null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
      {decided > 0 && (
        <>
          <span title="Router decision was used">Routed <b className="font-semibold text-text-main">{pct(router.routed)}</b></span>
          <span title="Session model kept (prompt cache retained)">Kept <b className="font-semibold text-text-main">{pct(router.kept)}</b></span>
          <span title="Router answered below the confidence threshold: configured member order was used">Low confidence <b className="font-semibold text-text-main">{pct(router.lowConfidence)}</b></span>
          <span title="Router gave no decision: configured member order was used">
            Router failed <b className={`font-semibold ${router.routerFailed > 0 ? "text-amber-600 dark:text-amber-400" : "text-text-main"}`}>{pct(router.routerFailed)}</b>
            {failReasons.length > 0 && <span> ({failReasons.slice(0, 2).map(([reason, n]) => `${routerFailLabel(reason)} ×${fmt(n)}`).join(", ")})</span>}
          </span>
          {router.defaulted > 0 && (
            <span title="Recorded before low confidence and router failures were tracked separately">Default order <b className="font-semibold text-text-main">{pct(router.defaulted)}</b></span>
          )}
          {avgConfidence && <span title="Average confidence of the router decisions that were used">Conf <b className="font-semibold text-text-main">{avgConfidence}</b></span>}
        </>
      )}
      {failover > 0 && (
        <span title="Served by a later member after the first choice failed">Failover <b className="font-semibold text-text-main">{fmt(failover)}</b></span>
      )}
    </div>
  );
}

function getGroupKey(item, keyField) {
  switch (keyField) {
    case "rawModel": return item.rawModel || "Unknown Model";
    case "accountName": return item.accountName || `Account ${item.connectionId?.slice(0, 8)}...` || "Unknown Account";
    case "keyName": return item.apiKeyMasked ? `${item.keyName} (${item.apiKeyMasked})` : item.keyName || "Unknown Key";
    case "endpoint": return item.endpoint || "Unknown Endpoint";
    case "combo": return item.combo || DIRECT_COMBO_LABEL;
    default: return item[keyField] || "Unknown";
  }
}

function groupDataByKey(data, keyField) {
  if (!Array.isArray(data)) return [];
  const groups = {};
  data.forEach((item) => {
    const gk = getGroupKey(item, keyField);
    if (!groups[gk]) {
      groups[gk] = {
        groupKey: gk,
        summary: { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, cost: 0, inputCost: 0, cachedCost: 0, outputCost: 0, lastUsed: null, pending: 0 },
        items: [],
      };
    }
    const s = groups[gk].summary;
    s.requests += item.requests || 0;
    s.promptTokens += item.promptTokens || 0;
    s.completionTokens += item.completionTokens || 0;
    s.cachedTokens += item.cachedTokens || 0;
    s.totalTokens += item.totalTokens || 0;
    s.cost += item.cost || 0;
    s.inputCost += item.inputCost || 0;
    s.cachedCost += item.cachedCost || 0;
    s.outputCost += item.outputCost || 0;
    s.pending += item.pending || 0;
    if (item.lastUsed && (!s.lastUsed || new Date(item.lastUsed) > new Date(s.lastUsed))) {
      s.lastUsed = item.lastUsed;
    }
    groups[gk].items.push(item);
  });
  return Object.values(groups);
}

const MODEL_COLUMNS = [
  { field: "rawModel", label: "Model" },
  { field: "provider", label: "Provider" },
  { field: "requests", label: "Requests", align: "right" },
  { field: "lastUsed", label: "Last Used", align: "right" },
];

const ACCOUNT_COLUMNS = [
  { field: "rawModel", label: "Model" },
  { field: "provider", label: "Provider" },
  { field: "accountName", label: "Account" },
  { field: "requests", label: "Requests", align: "right" },
  { field: "lastUsed", label: "Last Used", align: "right" },
];

const API_KEY_COLUMNS = [
  { field: "keyName", label: "API Key Name" },
  { field: "rawModel", label: "Model" },
  { field: "provider", label: "Provider" },
  { field: "requests", label: "Requests", align: "right" },
  { field: "lastUsed", label: "Last Used", align: "right" },
];

const ENDPOINT_COLUMNS = [
  { field: "endpoint", label: "Endpoint" },
  { field: "rawModel", label: "Model" },
  { field: "provider", label: "Provider" },
  { field: "requests", label: "Requests", align: "right" },
  { field: "lastUsed", label: "Last Used", align: "right" },
];

const COMBO_COLUMNS = [
  { field: "combo", label: "Combo" },
  { field: "rawModel", label: "Model Served" },
  { field: "provider", label: "Provider" },
  { field: "requests", label: "Requests", align: "right" },
  { field: "lastUsed", label: "Last Used", align: "right" },
];

const TABLE_OPTIONS = [
  { value: "model", label: "Model", countKey: "byModel", groupField: "rawModel" },
  { value: "account", label: "Account", countKey: "byAccount", groupField: "accountName" },
  { value: "apiKey", label: "API Key", countKey: "byApiKey", groupField: "keyName" },
  { value: "endpoint", label: "Endpoint", countKey: "byEndpoint", groupField: "endpoint" },
  { value: "combo", label: "Combo", countKey: "byCombo", groupField: "combo" },
];

const PERIODS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
  { value: "all", label: "All" },
];

export default function UsageStats({ period: periodProp, setPeriod: setPeriodProp, hidePeriodSelector = false } = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const sortBy = searchParams.get("sortBy") || "rawModel";
  const sortOrder = searchParams.get("sortOrder") || "asc";

  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  // Breakdown tab lives in the URL (?view=apiKey) so it survives reloads and can be linked.
  const viewParam = searchParams.get("view");
  const tableView = TABLE_OPTIONS.some((o) => o.value === viewParam) ? viewParam : "model";
  const [viewMode, setViewMode] = useState("costs");
  const [providers, setProviders] = useState([]);
  const [periodLocal, setPeriodLocal] = useState("today");
  // Cost backfill: bumping refreshKey refetches the stats afterwards.
  const [refreshKey, setRefreshKey] = useState(0);
  const [recalc, setRecalc] = useState({ busy: false, message: "" });

  const recalculateCosts = useCallback(async () => {
    if (!window.confirm("Recalculate costs?\n\nRequests recorded at $0 whose model has pricing now get a cost, and daily totals are rebuilt from the request history. Costs already recorded are not changed.")) return;
    setRecalc({ busy: true, message: "" });
    try {
      const res = await fetch("/api/usage/recalculate-costs", { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) throw new Error(data?.error || "Request failed");
      const skipped = data.daysSkipped ? `, ${data.daysSkipped} days skipped (incomplete history)` : "";
      const added = (data.costAdded || 0).toFixed(2);
      setRecalc({ busy: false, message: `${data.rowsRepriced} requests repriced, +$${added}${skipped}` });
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setRecalc({ busy: false, message: `Recalculation failed: ${e.message}` });
    }
  }, []);
  const isInitialLoad = useRef(true);
  const hasLoadedStats = useRef(false);
  const period = periodProp ?? periodLocal;
  const setPeriod = setPeriodProp ?? setPeriodLocal;

  // Fetch connected providers once, deduplicate by provider type
  // Always include noAuth free providers (e.g. opencode) regardless of connections
  useEffect(() => {
    Promise.all([
      fetch("/api/providers").then((r) => r.ok ? r.json() : null),
      fetch("/api/provider-nodes").then((r) => r.ok ? r.json() : null),
    ])
      .then(([d, nodesData]) => {
        // Build node name lookup for custom providers
        const nodeNameMap = {};
        for (const node of (nodesData?.nodes || [])) {
          nodeNameMap[node.id] = node.name;
        }
        const seen = new Set();
        const unique = (d?.connections || []).filter((c) => {
          if (c.isActive === false) return false;
          if (!isLLMProvider(c.provider)) return false;
          if (AI_PROVIDERS[c.provider]?.hidden) return false;
          if (seen.has(c.provider)) return false;
          seen.add(c.provider);
          return true;
        }).map((c) => ({
          ...c,
          nodeName: nodeNameMap[c.provider] || null,
        }));
        const noAuthProviders = Object.values(FREE_PROVIDERS)
          .filter((p) => p.noAuth && !p.hidden && !seen.has(p.id) && isLLMProvider(p.id))
          .map((p) => ({ provider: p.id, name: p.name }));
        setProviders([...unique, ...noAuthProviders]);
      })
      .catch(() => {});
  }, []);

  // Fetch filtered stats via REST when period changes
  useEffect(() => {
    // First load: show full spinner; subsequent: show subtle fetching indicator
    if (isInitialLoad.current) {
      isInitialLoad.current = false;
      setLoading(true);
    } else {
      setFetching(true);
    }

    fetch(`/api/usage/stats?period=${period}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data) {
          hasLoadedStats.current = true;
          setStats((prev) => ({ ...prev, ...data }));
        }
      })
      .catch(() => {})
      .finally(() => {
        setLoading(false);
        setFetching(false);
      });
  }, [period, refreshKey]);

  // SSE connection - real-time updates for activeRequests + recentRequests only
  useEffect(() => {
    const es = new EventSource("/api/usage/stream");

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        // Always merge only real-time fields, never overwrite full stats from REST
        setStats((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            activeRequests: data.activeRequests,
            recentRequests: data.recentRequests,
            errorProvider: data.errorProvider,
            pending: data.pending,
          };
        });
        if (hasLoadedStats.current) setLoading(false);
      } catch (err) {
        console.error("[SSE CLIENT] parse error:", err);
      }
    };

    es.onerror = () => setLoading(false);

    return () => es.close();
  }, []);

  const setTableView = useCallback((value) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("view", value);
    router.replace(`?${params.toString()}`, { scroll: false });
  }, [searchParams, router]);

  // Tabs show how many rows each breakdown has for the selected period.
  const tabOptions = useMemo(() => TABLE_OPTIONS.map((opt) => {
    const entries = stats?.[opt.countKey];
    if (!entries) return { value: opt.value, label: opt.label };
    const count = new Set(Object.values(entries).map((item) => getGroupKey(item, opt.groupField))).size;
    return { value: opt.value, label: `${opt.label} (${count})` };
  }), [stats]);

  const toggleSort = useCallback((tableType, field) => {
    const params = new URLSearchParams(searchParams.toString());
    if (params.get("sortBy") === field) {
      params.set("sortOrder", params.get("sortOrder") === "asc" ? "desc" : "asc");
    } else {
      params.set("sortBy", field);
      params.set("sortOrder", "asc");
    }
    router.replace(`?${params.toString()}`, { scroll: false });
  }, [searchParams, router]);

  // Compute active table data
  const activeTableConfig = useMemo(() => {
    if (!stats) return null;
    switch (tableView) {
      case "model": {
        const pendingMap = stats.pending?.byModel || {};
        return {
          columns: MODEL_COLUMNS,
          groupedData: groupDataByKey(sortData(stats.byModel, pendingMap, sortBy, sortOrder), "rawModel"),
          storageKey: "usage-stats:expanded-models",
          emptyMessage: "No usage recorded yet.",
          renderSummaryCells: (group) => (
            <>
              <td className="px-6 py-3 text-text-muted">—</td>
              <td className="px-6 py-3 text-right">{fmt(group.summary.requests)}</td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(group.summary.lastUsed)}</td>
            </>
          ),
          renderDetailCells: (item) => (
            <>
              <td className={`px-6 py-3 font-medium transition-colors ${item.pending > 0 ? "text-primary" : ""}`}>{item.rawModel}</td>
              <td className="px-6 py-3"><Badge variant={item.pending > 0 ? "primary" : "neutral"} size="sm">{item.provider}</Badge></td>
              <td className="px-6 py-3 text-right">{fmt(item.requests)}</td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(item.lastUsed)}</td>
            </>
          ),
        };
      }
      case "account": {
        const pendingMap = {};
        if (stats?.pending?.byAccount) {
          Object.entries(stats.byAccount || {}).forEach(([accountKey, data]) => {
            const connPending = stats.pending.byAccount[data.connectionId];
            if (connPending) {
              const modelKey = data.provider ? `${data.rawModel} (${data.provider})` : data.rawModel;
              pendingMap[accountKey] = connPending[modelKey] || 0;
            }
          });
        }
        return {
          columns: ACCOUNT_COLUMNS,
          groupedData: groupDataByKey(sortData(stats.byAccount, pendingMap, sortBy, sortOrder), "accountName"),
          storageKey: "usage-stats:expanded-accounts",
          emptyMessage: "No account-specific usage recorded yet.",
          renderSummaryCells: (group) => (
            <>
              <td className="px-6 py-3 text-text-muted">—</td>
              <td className="px-6 py-3 text-text-muted">—</td>
              <td className="px-6 py-3 text-right">{fmt(group.summary.requests)}</td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(group.summary.lastUsed)}</td>
            </>
          ),
          renderDetailCells: (item) => (
            <>
              <td className={`px-6 py-3 font-medium transition-colors ${item.pending > 0 ? "text-primary" : ""}`}>{item.accountName || `Account ${item.connectionId?.slice(0, 8)}...`}</td>
              <td className={`px-6 py-3 font-medium transition-colors ${item.pending > 0 ? "text-primary" : ""}`}>{item.rawModel}</td>
              <td className="px-6 py-3"><Badge variant={item.pending > 0 ? "primary" : "neutral"} size="sm">{item.provider}</Badge></td>
              <td className="px-6 py-3 text-right">{fmt(item.requests)}</td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(item.lastUsed)}</td>
            </>
          ),
        };
      }
      case "apiKey": {
        return {
          columns: API_KEY_COLUMNS,
          groupedData: groupDataByKey(sortData(stats.byApiKey, {}, sortBy, sortOrder), "keyName"),
          storageKey: "usage-stats:expanded-apikeys",
          emptyMessage: "No API key usage recorded yet.",
          // Name on its own line, masked key below it, group label beside:
          // two keys sharing a name stay distinguishable.
          renderGroupLabel: (group) => {
            const first = group.items[0] || {};
            return (
              <div className="flex flex-col items-start gap-0.5 min-w-0">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="font-medium">{first.keyName || group.groupKey}</span>
                  {first.keyGroup && (
                    <span
                      className="text-xs font-medium bg-primary/10 text-primary rounded-full px-2 py-0.5 whitespace-nowrap"
                      title={`Group: ${first.keyGroup}`}
                    >
                      {first.keyGroup}
                    </span>
                  )}
                </span>
                {first.apiKeyMasked && first.apiKeyMasked !== first.keyName && (
                  <span className="font-mono text-xs text-text-muted whitespace-nowrap">{first.apiKeyMasked}</span>
                )}
              </div>
            );
          },
          renderSummaryCells: (group) => (
            <>
              <td className="px-6 py-3 text-text-muted">—</td>
              <td className="px-6 py-3 text-text-muted">—</td>
              <td className="px-6 py-3 text-right">{fmt(group.summary.requests)}</td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(group.summary.lastUsed)}</td>
            </>
          ),
          renderDetailCells: (item) => (
            <>
              <td className="px-6 py-3 font-medium font-mono text-xs">{item.apiKeyMasked || item.keyName}</td>
              <td className="px-6 py-3">{item.rawModel}</td>
              <td className="px-6 py-3"><Badge variant="neutral" size="sm">{item.provider}</Badge></td>
              <td className="px-6 py-3 text-right">{fmt(item.requests)}</td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(item.lastUsed)}</td>
            </>
          ),
        };
      }
      case "combo": {
        const groupedData = groupDataByKey(sortData(stats.byCombo, {}, sortBy, sortOrder), "combo");
        // Share = portion of the combo's requests that this model ended up serving
        for (const group of groupedData) {
          const router = { routed: 0, kept: 0, lowConfidence: 0, routerFailed: 0, defaulted: 0, failover: 0, confidenceSum: 0, confidenceCount: 0 };
          const failReasons = {};
          for (const item of group.items) {
            item.share = group.summary.requests > 0 ? Math.round((item.requests / group.summary.requests) * 100) : 0;
            for (const f of Object.keys(router)) router[f] += item[f] || 0;
            for (const [reason, n] of Object.entries(item.failReasons || {})) failReasons[reason] = (failReasons[reason] || 0) + n;
          }
          group.router = { ...router, failReasons };
        }
        return {
          columns: COMBO_COLUMNS,
          groupedData,
          storageKey: "usage-stats:expanded-combos",
          emptyMessage: "No combo usage recorded yet. Combo names are tracked from the moment this view was added.",
          renderSummaryCells: (group) => (
            <>
              <td colSpan={2} className="px-6 py-3"><ComboRouterStats router={group.router} /></td>
              <td className="px-6 py-3 text-right">{fmt(group.summary.requests)}</td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(group.summary.lastUsed)}</td>
            </>
          ),
          renderDetailCells: (item) => (
            <>
              <td className="px-6 py-3 text-xs text-text-muted">{item.comboVia ? `via ${item.comboVia}` : ""}</td>
              <td className="px-6 py-3 font-medium">{item.rawModel}</td>
              <td className="px-6 py-3"><Badge variant="neutral" size="sm">{item.provider}</Badge></td>
              <td className="px-6 py-3 text-right whitespace-nowrap">
                <div className="flex items-center justify-end gap-2">
                  <span>{fmt(item.requests)}</span>
                  <span className="w-9 text-xs text-text-muted">{item.share}%</span>
                  <span className="h-1.5 w-16 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
                    <span className="block h-full bg-primary" style={{ width: `${item.share}%` }} />
                  </span>
                </div>
              </td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(item.lastUsed)}</td>
            </>
          ),
        };
      }
      case "endpoint":
      default: {
        return {
          columns: ENDPOINT_COLUMNS,
          groupedData: groupDataByKey(sortData(stats.byEndpoint, {}, sortBy, sortOrder), "endpoint"),
          storageKey: "usage-stats:expanded-endpoints",
          emptyMessage: "No endpoint usage recorded yet.",
          renderSummaryCells: (group) => (
            <>
              <td className="px-6 py-3 text-text-muted">—</td>
              <td className="px-6 py-3 text-text-muted">—</td>
              <td className="px-6 py-3 text-right">{fmt(group.summary.requests)}</td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(group.summary.lastUsed)}</td>
            </>
          ),
          renderDetailCells: (item) => (
            <>
              <td className="px-6 py-3 font-medium font-mono text-sm">{item.endpoint}</td>
              <td className="px-6 py-3">{item.rawModel}</td>
              <td className="px-6 py-3"><Badge variant="neutral" size="sm">{item.provider}</Badge></td>
              <td className="px-6 py-3 text-right">{fmt(item.requests)}</td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(item.lastUsed)}</td>
            </>
          ),
        };
      }
    }
  }, [stats, tableView, sortBy, sortOrder]);

  if (!stats && !loading) return <div className="text-text-muted">Failed to load usage statistics.</div>;

  const spinner = (
    <div className="flex items-center justify-center py-12 text-text-muted">
      <span className="material-symbols-outlined text-[32px] animate-spin">progress_activity</span>
    </div>
  );

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {/* Period selector (hidden when controlled by parent) */}
      {!hidePeriodSelector && (
        <div className="flex w-full items-center gap-2 sm:w-auto sm:self-end">
          <div className="grid flex-1 grid-cols-6 items-center gap-1 rounded-lg border border-border bg-bg-subtle p-1 sm:flex sm:flex-none">
            {PERIODS.map((p) => (
              <button
                key={p.value}
                onClick={() => setPeriod(p.value)}
                disabled={fetching}
                className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${period === p.value ? "bg-primary text-white shadow-sm" : "text-text-muted hover:bg-bg-hover hover:text-text"}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          {fetching && (
            <span className="material-symbols-outlined text-[16px] text-text-muted animate-spin">progress_activity</span>
          )}
        </div>
      )}

      {/* Overview cards */}
      {loading ? spinner : <OverviewCards stats={stats} />}

      {/* Provider topology + Recent Requests */}
      {loading ? spinner : (
        <div className="grid min-w-0 grid-cols-1 items-stretch gap-2 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
          <ProviderTopology
            providers={providers}
            activeRequests={stats.activeRequests || []}
            lastProvider={stats.recentRequests?.[0]?.provider || ""}
            errorProvider={stats.errorProvider || ""}
          />
          <RecentRequests requests={stats.recentRequests || []} />
        </div>
      )}

      {/* Token / Cost chart - sync period */}
      {loading ? spinner : <UsageChart period={period} />}

      {/* Provider and model breakdown charts */}
      {!loading && (stats.byProvider || stats.byModel) && (
        <div className="grid min-w-0 grid-cols-1 gap-2 lg:grid-cols-2">
          <ProviderBarChart byProvider={stats.byProvider} />
          <TopModelsChart byModel={stats.byModel} />
        </div>
      )}

      {/* Table with dropdown selector */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <SegmentedControl
            options={tabOptions}
            value={tableView}
            onChange={setTableView}
            size="sm"
            className="w-full sm:w-auto"
          />
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            {recalc.message && <span className="text-xs text-text-muted" role="status">{recalc.message}</span>}
            <button
              onClick={recalculateCosts}
              disabled={recalc.busy}
              title="Fill in costs for requests recorded at $0 whose model has pricing now"
              className="flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-text-muted transition-colors hover:bg-bg-hover hover:text-text disabled:opacity-50"
            >
              <span className={`material-symbols-outlined text-[16px] ${recalc.busy ? "animate-spin" : ""}`}>{recalc.busy ? "progress_activity" : "calculate"}</span>
              {recalc.busy ? "Recalculating..." : "Recalculate costs"}
            </button>
          <div className="grid grid-cols-2 items-center gap-1 rounded-lg border border-border bg-bg-subtle p-1 sm:flex">
            <button
              onClick={() => setViewMode("costs")}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${viewMode === "costs" ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text hover:bg-bg-hover"}`}
            >
              Costs
            </button>
            <button
              onClick={() => setViewMode("tokens")}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${viewMode === "tokens" ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text hover:bg-bg-hover"}`}
            >
              Tokens
            </button>
          </div>
          </div>
        </div>
        {/* Per-key usage over time, only on the API Key breakdown */}
        {!loading && tableView === "apiKey" && <ApiKeyUsageChart period={period} />}
        {loading ? spinner : activeTableConfig && (
          <UsageTable
            title=""
            columns={activeTableConfig.columns}
            groupedData={activeTableConfig.groupedData}
            tableType={tableView}
            sortBy={sortBy}
            sortOrder={sortOrder}
            onToggleSort={toggleSort}
            viewMode={viewMode}
            storageKey={activeTableConfig.storageKey}
            renderSummaryCells={activeTableConfig.renderSummaryCells}
            renderGroupLabel={activeTableConfig.renderGroupLabel}
            renderDetailCells={activeTableConfig.renderDetailCells}
            emptyMessage={activeTableConfig.emptyMessage}
          />
        )}
      </div>
    </div>
  );
}
