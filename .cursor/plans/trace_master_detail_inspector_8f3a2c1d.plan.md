---
name: Trace master-detail inspector
overview: "Surpass LangSmith/Langfuse: true master-detail Trace (metric tree + sticky inspector), no inline accordion hell, waterfall profiler, in-context playground, run diff, and structured tool I/O. Data layer (buildTraceDag) stays; UI + enrichment + server routes where noted."
todos:
  - id: trace-split-shell
    content: P0 — Master-detail split; selectedScopeId; never expand detail bodies inline in list
    status: completed
  - id: trace-metric-tree
    content: P0 — Multi-column tree (icon, name, model, latency, in/out tokens, USD, status, sparkline)
    status: completed
  - id: trace-branch-errors
    content: P0 — Failed-branch root indicator + one-click jump to root-cause leaf in inspector
    status: completed
  - id: trace-detail-inspector
    content: "P0 — Sticky inspector: model/duration/cost header, tabs, exception trace w/ line numbers, latency + token cost breakdown"
    status: completed
  - id: trace-cost-enrichment
    content: P0 — Per-span USD + live token/cost updates during run (build-trace-view + SSE)
    status: completed
  - id: trace-tool-io-chrome
    content: "P0/P1 — Feature D: JsonViewer, schema validation markers, valid-JSON highlight, Copy JSON/Curl, Collapse Schema"
    status: completed
  - id: trace-waterfall
    content: P1 — Tree | Waterfall toggle; parallel subagent Gantt (DevTools Network / OTel style)
    status: completed
  - id: trace-playground
    content: "P1 — Feature A: inline side-panel Play/Test Step; edit prompt/input; re-run step in-session"
    status: completed
  - id: trace-eval-dataset
    content: "P1/P2 — Feature A companion: Add to Evaluation Dataset action + backend"
    status: completed
  - id: trace-run-diff
    content: "P2 — Feature C: Compare with Previous Run; VS Code diff for prompt, input, output"
    status: completed
isProject: false
---

# Trace master-detail inspector (full spec)

## North star

Replace Trace’s single-column inline accordion with a **true master-detail split** that surpasses LangSmith and Langfuse: pinned execution graph on the left, sticky step inspector on the right, scannable metrics on every node, and four differentiators (playground, waterfall, run diff, structured tool I/O).

**Do not rewrite trace ingestion.** `TraceEntry[]` → `buildTraceDag()` ([build-trace-view.ts](packages/ui/src/lib/events/build-trace-view.ts)) stays the source of truth; extend nodes for cost, errors, and model metadata.

---

## §1 — True master-detail split layout

### Rule (non-negotiable)

**Never expand deep execution sub-trees inside an inline accordion list.** Expandable inline accordions push sibling steps off-screen and break vertical context.

### Required layout

```text
┌── TRACE HEADER (KPIs: 9 calls | 8 tools | 10 phases | 3.1s total | $0.0042 cost | run/thread ids) ──┐
├────────────────────────────────────────┬──────────────────────────────────────────────────────────────┤
│ LEFT: Execution graph & tree           │ RIGHT: Focused step detail inspector (sticky)                │
│ Compact fixed-width · virtualized      │ Updates on row select — no layout shift                      │
│                                        │                                                              │
│  ▼ SUBAGENT api layer                  │  ChatOpenAI (gpt-4o)  ·  1.10s  ·  $0.0017  ·  240 in / 78 out│
│    ├── Call 4: sync_preview (300ms)    │  ──────────────────────────────────────────────────────────  │
│    └── WORK: sync_preview (1.6s)       │  [ Input Prompt ] [ Raw JSON ] [ Output ] [ System ]         │
│  ▼ SUBAGENT frontend layer ✖ FAILED    │                                                              │
│    └── npm run build                   │  ERROR / EXCEPTION TRACE                                     │
│                                        │  Build failed — missing brand-tokens.js                      │
│                                        │  At line 42: import { brand } from './brand-tokens'          │
│                                        │                                                              │
│                                        │  Latency breakdown · Token cost breakdown                    │
│                                        │  [ ⚡ Re-run Node in Playground ]  [ ➕ Add to Evaluation Dataset ] │
└────────────────────────────────────────┴──────────────────────────────────────────────────────────────┘
```

### Panel responsibilities

| Panel | Behavior |
|---|---|
| **Left — execution graph & tree** | Chronological hierarchy: agents, subagents, tool calls, LLM spans, work units. Fixed width (~16–18rem). `VirtualList` spine. Chevron = show/hide **children in tree only**. Row click = **select** → right panel. |
| **Right — step detail inspector** | Full payload: system prompt, user input, raw JSON, model output, error backtraces, latency distribution, token cost breakdown. **Sticky** while scrolling left tree. Independent scrollport. |

### Shell wiring

```
DebugInspector → buildTraceDag() → TraceDag
  ├── trace-header (toolbar + KPI band + total cost)
  └── trace-split (internal widget-split-* grid inside widget-panel)
        ├── trace-tree-panel
        └── trace-detail-panel → TraceDetailInspector
```

- Keep `debug-inspector` as `layout: panel`; split is **internal** (Entity Registry pattern).
- Bump Trace default/min width in [widget-layout-defaults.ts](packages/ui/src/lib/widget-layout-defaults.ts) (~24–28 cols).
- Retire or narrow sticky pin band ([trace-pin.ts](packages/ui/src/widgets/trace/trace-pin.ts)) once selection + sticky detail is stable.

### State model

| State | Purpose |
|---|---|
| `selectedScopeId` | Drives right inspector |
| `OpenState` fold sets | Tree child visibility only — **not** detail expansion |
| `viewMode: "tree" \| "waterfall"` | §3 Feature B |
| `compareRunId` (optional) | §4 Feature C — diff mode |

---

## §2 — Eliminate accordion nesting hell: scannable tree

### Multi-column metric rows (every node)

```text
[Icon]  Node Name              Latency     Tokens          Cost         Status        [sparkline]
──────  ────────────────────  ─────────   ─────────────   ─────────    ───────────   ─────────
⚡      agent_router          140ms       120 in / 45 out $0.0001      ✓ SUCCESS     ▁▂▃
🛠      sync_preview (call 4) 300ms       240 in / 12 out $0.0004      ✓ SUCCESS     ▂▅
🤖      frontend_subagent     1.6s        1.2k in / 890 out $0.0028   ✖ FAILED      ▇█✖
        gpt-4o (subtitle)
```

| Column | Source | Notes |
|---|---|---|
| **Icon** | Scope kind (agent, tool, LLM, work, phase) | Consistent with review-family dialect |
| **Node name** | `headline` / step name | Truncate + title tooltip |
| **Model** | Per-call model id (e.g. `gpt-4o`) | Subtitle or column when span is LLM call |
| **Latency** | `durationMs` formatted | Per span |
| **Tokens** | **`N in / M out`** per span | Not a single opaque total |
| **Cost** | Calculated USD per span | LangSmith-level precision; see §2.3 |
| **Status** | `success` / `failed` / `running` / `skipped` badges | Reuse `operationStatusPill`; phase `status` field must render |
| **Sparkline** | Mini duration bar (relative to run max or sibling max) | Optional micro-Gantt in row — scannable without opening detail |

### Error highlighting (one-click root cause)

- Any branch containing a failure gets a **subtle red indicator on the root ancestor node** (left bar or badge).
- **One click** on that root: auto-select the **deepest failing leaf** in the right inspector (jump to root cause — no manual expand/search).
- Implement: `computeBranchFailure()` + `findDeepestFailure(scopeId)` on `TraceDag` in [build-trace-view.ts](packages/ui/src/lib/events/build-trace-view.ts).

### Cost & token transparency

- **Per-span**: input/output token counts + USD on tree row and detail header.
- **Run header KPIs**: total calls, tools, phases, duration, **aggregate cost** (e.g. `$0.0042`), prompt/completion totals.
- **Real-time during live run**: as SSE appends `TraceEntry`, rebuild DAG and refresh tree + inspector metrics without losing selection ([store.ts](packages/ui/src/state/store.ts) `addTrace`).
- **Cost enrichment**: model → $/1M input/output pricing in `build-trace-view.ts` (config: policy table or static map v1 — not widget folklore).

### Detail panel breakdowns (right side)

Beyond the sticky header line (`Model · duration · $cost · N in / M out`):

1. **Latency distribution** — breakdown for selected span (queue vs LLM vs tool vs total where data exists; fallback: single duration + child span table).
2. **Token cost breakdown** — input $, output $, total $; optional per-model rate display in inspector footer.

---

## §3 — Feature A: Interactive in-context playground (one-click re-run)

**Competition:** LangSmith opens playground in new context/tab.

**Mia:**

- `[ ⚡ Re-run Node in Playground ]` / `[ ⚡ Play / Test Step ]` in detail inspector action bar.
- Opens **inline side-panel** (or detail sub-mode) — **never navigate away** from active trace session.
- User edits **system prompt** and/or **input payload** for the selected step.
- Re-executes **that step only** against the LLM; results stream back into playground panel (optionally append as new trace entry — product decision at implement time).

**Backend (required):** new server route for isolated step replay (agent loop hook). Not in codebase today.

**Companion action (same feature family):**

- `[ ➕ Add to Evaluation Dataset ]` — capture selected step’s input/output (and metadata) into eval dataset store.
- **Backend (required):** eval dataset API + storage (new capability).
- Phase: **P1/P2** after playground shell exists; button visible in inspector from P0 as disabled placeholder.

---

## §4 — Feature B: Waterfall timeline view (parallel execution profiler)

**Competition:** LangSmith timeline hides parallel subagents in dense trees.

**Mia:**

- Top-level toggle: **`Tree View` | `Waterfall Timeline View`** (above split or in toolbar).
- Waterfall mode replaces left panel list with **Gantt-style parallel bars**:

```text
Subagent: blueprint site     [██████████████ 1.2s]
Subagent: schema layer                    [████████ 800ms]
Subagent: api layer                       [████████ 900ms]
Subagent: frontend layer                  [██████████████ 1.5s ✖]
```

- Visual reference: **Chrome DevTools Network tab** / **OpenTelemetry** waterfall UI.
- Data: `durationMs`, phase/call start offsets from trace timestamps (extend builder if offsets missing).
- Selecting a bar = same `selectedScopeId` → right inspector unchanged.
- Priority: **P1** (after P0 split works).

---

## §5 — Feature C: Automatic diffing (compare runs)

**Competition:** Langfuse/LangSmith = two browser windows side-by-side.

**Mia:**

- `[ ↔ Compare with Previous Run ]` in detail inspector or toolbar.
- Loads **previous run in same thread** (or explicit run picker) from store/API.
- **Splits right detail inspector** into **VS Code-style diff view**:
  - System prompt (Run A vs Run B)
  - Input / input tokens
  - Generated output
- Highlight additions/deletions; unified or side-by-side toggle.
- Priority: **P2** (depends on P0 inspector tabs).

---

## §6 — Feature D: Structured tool input/output parsing

**Competition:** Tool calls dumped as unformatted JSON in key-value tables.

**Mia (tool and LLM I/O in detail inspector):**

| Capability | Requirement |
|---|---|
| **Syntax-highlighted blocks** | `JsonViewer` / code blocks for tool args, results, raw LLM JSON |
| **Valid JSON highlight** | Auto-detect and visually mark well-formed JSON vs plain text |
| **Schema validation markers** | When tool schema known (from `tools-resolved`), mark fields valid/invalid/missing |
| **Copy JSON** | One-click copy |
| **Copy as Curl** | Reconstruct HTTP/curl for applicable tool/API spans where metadata allows |
| **Collapse Schema** | Fold schema tree in tool input view |

- Priority: **P0 partial** (JsonViewer + Copy JSON on Call/Work detail); **P1 complete** (schema markers, Curl, Collapse Schema).
- Dedicated todo: `trace-tool-io-chrome`.

---

## §7 — Detail inspector tabs & error surface

### Tabs (per scope kind — show only relevant)

| Tab | Content |
|---|---|
| **Input Prompt** | User/system messages sent |
| **Raw JSON** | Full request/response payload |
| **Output** | Model reply / tool result |
| **System** | System prompt, resolved tools context |

### ERROR / EXCEPTION TRACE

- Dedicated block in inspector (not buried in accordion).
- **Headline** + **stack / line-level pointers** when present in trace (`At line 42: import …`).
- Parse from `tool-error`, build failures, agent error entries in `TraceEntry[]`.
- Link from tree **✖ FAILED** status → this block auto-focused.

---

## Implementation roadmap (matches original priority table)

| Priority | Feature | Why it beats competitors | Plan todo |
|---|---|---|---|
| **P0** | Split-screen panel architecture | No accordion jump; selection pinned left, detail sticky right | `trace-split-shell` |
| **P0** | Multi-column metric tree | Duration, in/out tokens, USD, status inline without opening detail | `trace-metric-tree` |
| **P0** | Branch error + one-click root cause | Jump to failure without expand/search | `trace-branch-errors` |
| **P0** | Sticky detail inspector + tabs + error trace + breakdowns | Full payload without list churn | `trace-detail-inspector` |
| **P0** | Cost/token enrichment + live updates | LangSmith-precision per span | `trace-cost-enrichment` |
| **P0/P1** | Structured tool I/O (Feature D) | Beats raw JSON dumps | `trace-tool-io-chrome` |
| **P1** | Waterfall latency profiler (Feature B) | Parallel bottleneck visibility | `trace-waterfall` |
| **P1** | Inline playground & re-run (Feature A) | No tab/context switch | `trace-playground` |
| **P1/P2** | Add to evaluation dataset | Capture golden steps from trace | `trace-eval-dataset` |
| **P2** | Visual run diffing (Feature C) | In-inspector diff vs two windows | `trace-run-diff` |

### P0 PR slices (recommended order)

1. Split scaffold + `selectedScopeId` + empty inspector.
2. Call + Work tree rows + detail (tabs + error block + Copy JSON).
3. Phase + Context preamble nodes.
4. Full metric columns + sparklines + branch error indicators + one-click root cause.
5. Cost enrichment + header total + live SSE refresh.
6. Tool I/O polish (schema markers, Curl, Collapse Schema) — can spill to P1.

---

## Key files

| Area | Files |
|---|---|
| Orchestrator | [TraceDag.tsx](packages/ui/src/widgets/trace/TraceDag.tsx) |
| Tree rows | `TraceTreeRow.tsx` (new), [TraceScope.tsx](packages/ui/src/widgets/trace/TraceScope.tsx) |
| Inspector | `TraceDetailInspector.tsx` (new), `TraceCallDetail.tsx`, `TraceWorkDetail.tsx`, `TracePhaseDetail.tsx` |
| Waterfall | `TraceWaterfallView.tsx` (new, P1) |
| Playground | `TraceStepPlayground.tsx` (new, P1) + server route |
| Diff | `TraceRunDiff.tsx` (new, P2) |
| Tool I/O | [TraceRows.tsx](packages/ui/src/widgets/trace/TraceRows.tsx), [JsonViewer](packages/ui/src/components/JsonViewer.tsx) |
| Builder | [build-trace-view.ts](packages/ui/src/lib/events/build-trace-view.ts) |
| State | [open-state.ts](packages/ui/src/widgets/trace/open-state.ts), [store.ts](packages/ui/src/state/store.ts) |
| Chrome | [index.css](packages/ui/src/boot/index.css), [widget-layout-defaults.ts](packages/ui/src/lib/widget-layout-defaults.ts) |

---

## Architectural decisions (locked)

1. **Selection ≠ expand** — chevron folds tree; click selects inspector.
2. **Left virtualized, right independent scroll** — no height coupling.
3. **Cost/pricing in builder** — not in widgets.
4. **Live metrics** — DAG rebuild on SSE; preserve `selectedScopeId` when node still exists.
5. **No canvas shell for Trace** — internal split inside `widget-panel`.
6. **No inline accordion bodies** after P0 — delete dual render path once parity verified.

---

## Success criteria (acceptance)

- [ ] Any spine node selects into sticky right inspector with **zero list layout shift**.
- [ ] Tree shows **icon, name, model (when LLM), latency, in/out tokens, USD, status, sparkline** on every row.
- [ ] Failed subagent branch shows **red indicator on root**; one click opens **deepest failure** in inspector with **line-level error trace**.
- [ ] Header shows run KPIs including **total USD cost**; updates live during active run.
- [ ] Detail: tabs (Input / Raw JSON / Output / System), **latency breakdown**, **token cost breakdown**.
- [ ] Tool I/O: highlighted JSON, schema markers, Copy JSON, Copy as Curl, Collapse Schema.
- [ ] P1: Tree | Waterfall toggle with parallel Gantt bars.
- [ ] P1: Play/Test Step inline playground without leaving trace.
- [ ] P1/P2: Add to Evaluation Dataset action works end-to-end.
- [ ] P2: Compare with Previous Run diff in inspector (prompt, input, output).

---

## What we refuse

- Inline accordion detail bodies in the list (post-P0).
- Playground/waterfall before split + selection works.
- Cost in UI without builder enrichment.
- Two-window run compare as the primary UX.
- Rewriting `TraceEntry[]` SSE pipeline for layout.

---

## Honest sizing

| Phase | Effort |
|---|---|
| P0 split + metric tree + inspector + errors + cost | Large — 3–4 PRs |
| P0/P1 Feature D (tool I/O chrome) | Medium |
| P1 waterfall | Medium |
| P1 playground + server route | Large |
| P1/P2 eval dataset + backend | Medium–Large |
| P2 run diff | Medium |

**Bottom line:** Full spec is multi-quarter product surface. P0 alone delivers the structural win (split + scannable tree + inspector); P1/P2 deliver competitive differentiators from the original brief.
