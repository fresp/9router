// Live eval harness for combos and direct models.
//
//   EVAL_BASE_URL=https://host EVAL_API_KEY=sk-... \
//     node scripts/combo-eval/run.mjs run --set scripts/combo-eval/prompts.jsonl --out out.jsonl
//   node scripts/combo-eval/run.mjs report --in out.jsonl
//
// run options:
//   --target <model>   send every case to this model/combo instead of case.combo
//   --combo <name>     only run cases whose combo matches
//   --runs <n>         repetitions per case (default 1)
//   --max-tokens <n>   cap generation (default 16; routing is decided before generation)
//   --sticky           reuse the same session across runs (default: fresh session per request)
//   --concurrency <n>  parallel requests (default 2)
//
// The API key is read from the environment only and is never written to the output.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { args._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}

function readJsonl(file) {
  return fs.readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//"))
    .map((l) => JSON.parse(l));
}

// Routing stickiness is keyed on the first user message, and the router reads only the
// latest one. A throwaway first turn gives every request its own session without
// changing the text the router classifies.
function buildMessages(prompt, sticky) {
  if (sticky) return [{ role: "user", content: prompt }];
  return [
    { role: "user", content: `Eval session ${crypto.randomUUID()}. Reply "ok".` },
    { role: "assistant", content: "ok" },
    { role: "user", content: prompt },
  ];
}

// Map the model id a response reports back to a combo member label.
function memberOf(combo, model, members) {
  const table = members[combo];
  if (!table || !model) return null;
  const id = String(model).toLowerCase();
  for (const [label, needles] of Object.entries(table)) {
    // "=name" matches the whole id, anything else matches a substring.
    if (needles.some((n) => (n.startsWith("=") ? id === n.slice(1).toLowerCase() : id.includes(n.toLowerCase())))) return label;
  }
  return null;
}

async function sendOne({ baseUrl, apiKey, model, messages, maxTokens, timeoutMs }) {
  const started = Date.now();
  const out = { status: 0, model: null, ttftMs: null, totalMs: null, text: "", finish: null, usage: null, error: null };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true } }),
      signal: ctrl.signal,
    });
    out.status = res.status;
    if (!res.ok || !res.body) {
      out.error = (await res.text()).slice(0, 500);
      return out;
    }
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let evt;
        try { evt = JSON.parse(data); } catch { continue; }
        if (evt.error) out.error = JSON.stringify(evt.error).slice(0, 500);
        // Keepalive chunks carry a placeholder model; the real id arrives with the first upstream chunk.
        if (evt.model && evt.model !== "keepalive") out.model = evt.model;
        if (evt.usage) out.usage = evt.usage;
        const choice = evt.choices?.[0];
        const delta = choice?.delta?.content;
        if (typeof delta === "string" && delta) {
          if (out.ttftMs === null) out.ttftMs = Date.now() - started;
          out.text += delta;
        }
        if (choice?.finish_reason) out.finish = choice.finish_reason;
      }
    }
  } catch (err) {
    out.error = err?.name === "AbortError" ? `timeout after ${timeoutMs}ms` : String(err?.message || err);
  } finally {
    clearTimeout(timer);
    out.totalMs = Date.now() - started;
  }
  return out;
}

async function pool(items, size, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  }));
}

async function cmdRun(args) {
  const baseUrl = process.env.EVAL_BASE_URL;
  const apiKey = process.env.EVAL_API_KEY;
  if (!baseUrl || !apiKey) throw new Error("Set EVAL_BASE_URL and EVAL_API_KEY in the environment.");
  if (!args.set || !args.out) throw new Error("run needs --set <prompts.jsonl> and --out <results.jsonl>");

  const members = JSON.parse(fs.readFileSync(args.members || path.join(HERE, "members.json"), "utf8"));
  const runs = Number(args.runs || 1);
  const maxTokens = Number(args["max-tokens"] || 16);
  const timeoutMs = Number(args.timeout || 120000);
  let cases = readJsonl(args.set);
  if (args.combo) cases = cases.filter((c) => c.combo === args.combo);

  const jobs = [];
  for (const c of cases) for (let r = 0; r < runs; r++) jobs.push({ c, r });

  const outStream = fs.createWriteStream(args.out, { flags: "a" });
  let done = 0;
  await pool(jobs, Number(args.concurrency || 2), async ({ c, r }) => {
    const model = args.target || c.combo;
    const res = await sendOne({ baseUrl, apiKey, model, messages: buildMessages(c.prompt, !!args.sticky), maxTokens, timeoutMs });
    const row = {
      id: c.id, run: r, requested: model, combo: c.combo, expected: c.label, tags: c.tags || [],
      served: res.model, member: memberOf(c.combo, res.model, members),
      status: res.status, ttftMs: res.ttftMs, totalMs: res.totalMs, finish: res.finish,
      usage: res.usage, error: res.error, text: res.text, at: new Date().toISOString(),
    };
    outStream.write(JSON.stringify(row) + "\n");
    done++;
    console.log(`[${done}/${jobs.length}] ${c.id} → ${row.served || "-"} (${row.member || "?"}) ${row.status} ${row.totalMs}ms${row.error ? " ERROR" : ""}`);
  });
  await new Promise((resolve) => outStream.end(resolve));
  report(readJsonl(args.out));
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function report(rows) {
  const byRequested = new Map();
  for (const r of rows) {
    if (!byRequested.has(r.requested)) byRequested.set(r.requested, []);
    byRequested.get(r.requested).push(r);
  }
  for (const [requested, list] of byRequested) {
    const ok = list.filter((r) => r.status === 200 && !r.error);
    const total = [...ok.map((r) => r.totalMs)].sort((a, b) => a - b);
    const ttft = ok.map((r) => r.ttftMs).filter((v) => v !== null).sort((a, b) => a - b);
    console.log(`\n=== ${requested} — ${list.length} requests, ${list.length - ok.length} failed`);
    console.log(`latency total p50/p95: ${pct(total, 50)}/${pct(total, 95)} ms · ttft p50/p95: ${pct(ttft, 50)}/${pct(ttft, 95)} ms`);

    const served = {};
    for (const r of ok) served[r.served || "(none)"] = (served[r.served || "(none)"] || 0) + 1;
    console.log("served models:", served);

    // Routing accuracy only where the response model maps to a known member.
    const graded = ok.filter((r) => r.expected && r.member);
    if (graded.length) {
      const hit = graded.filter((r) => r.member === r.expected).length;
      console.log(`routing accuracy: ${hit}/${graded.length} (${((hit / graded.length) * 100).toFixed(1)}%) · unmapped: ${ok.length - graded.length}`);
      const matrix = {};
      for (const r of graded) {
        matrix[r.expected] ??= {};
        matrix[r.expected][r.member] = (matrix[r.expected][r.member] || 0) + 1;
      }
      console.log("confusion (expected → got):");
      for (const [exp, got] of Object.entries(matrix)) console.log(`  ${exp} → ${JSON.stringify(got)}`);
      const misses = graded.filter((r) => r.member !== r.expected);
      for (const r of misses) console.log(`  miss ${r.id} run ${r.run}: expected ${r.expected}, got ${r.member} [${r.tags.join(",")}]`);
    } else if (ok.length) {
      console.log("routing accuracy: n/a (no response model mapped to a member — check members.json)");
    }
    const errors = list.filter((r) => r.status !== 200 || r.error);
    for (const r of errors.slice(0, 10)) console.log(`  error ${r.id}: ${r.status} ${String(r.error).slice(0, 160)}`);
  }
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
try {
  if (cmd === "run") await cmdRun(args);
  else if (cmd === "report") {
    if (!args.in) throw new Error("report needs --in <results.jsonl>");
    report(readJsonl(args.in));
  } else throw new Error("usage: run.mjs run|report [options] (see header)");
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
