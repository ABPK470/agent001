# Memory — episodic tiers, goal classes, and recall affinity

Durable memory lives here (`ingestion.ts`, `retrieval.ts`, `goal-class.ts`, …).
This document covers **goal classes** — how we tag task *shape* for episodic FTS
recall and shortcut eligibility.

Implementation: `goal-class.ts`. Prompt/tool gating uses a related but separate
layer in `runtime/prompting/goal-classification.ts` (`syncIntent`, `dbScore`).

---

## Why goal classes exist

Episodic FTS matches surface tokens well (“top 3 products … April 2025”) but
poorly across analogous shapes (“top 50 clients by revenue”). Goal classes are
single-token CamelCase tags appended to the FTS index at ingest time so
shape-similar goals can recall each other without near-duplicate wording.

They also gate **episodic shortcut**: the “MEMORY HIT — reuse prior choreography”
banner only applies when the current goal shares task shape with the remembered
run — not merely the same domain words (e.g. “pipelines” in both).

---

## Class tags

| Tag | Meaning | Example goals |
|-----|---------|---------------|
| `rankbymetric` | Ranked list by a metric | “top 50 clients by revenue”, “highest margin products” |
| `aggregateby` | Count / sum / distinct / how many | “how many distinct pipelines in UAT”, “total revenue” |
| `syncreconcile` | Cross-env metadata reconciliation | “reconcile pipelineActivity uat vs dev”, “compare catalogs uat vs dev”, “out of sync between dev and prod” |
| `comparison` | Analytic trend / period-over-period | “revenue yoy growth trend”, “month over month change” |
| `lookup` | Exploratory list / describe / what-is | “list tables”, “show me …”, “what is …” |
| `pivotbydim` | Breakdown by a business dimension | “revenue by month”, “sales per client” |
| `timefiltered` | Explicit calendar / period window | “April 2025”, “Q3 2024”, “last 12 months” |
| `exportfile` | Export to file format | “export to csv”, “save to xlsx” |

**Shape classes** (discriminating for affinity): `rankbymetric`, `aggregateby`,
`syncreconcile`, `lookup`, `exportfile`, `pivotbydim`.

**Modifier classes** (ambient — not used alone for cross-shape affinity):
`comparison`, `timefiltered`.

---

## `syncreconcile` vs `comparison`

These must not overlap on bare environment phrasing.

- **`comparison`** — analytic signals only: `yoy`, `trend`, `growth`,
  `compared to`, `difference between`, `month over month`, etc. Bare `vs` is
  **not** a comparison tag.
- **`syncreconcile`** — explicit reconcile/drift/sync vocabulary **or** cross-env
  shape: `uat vs dev`, `between uat and dev` (with env labels).

**Count guard:** cross-env `vs` / `between` does **not** tag `syncreconcile` when
the goal is clearly a count (`how many`, `distinct`, `number of`, …) or already
has `aggregateby`. Example: “how many pipelines in uat vs dev” → `aggregateby`
only.

---

## Affinity rules (`goalClassesShareAffinity`)

Episodic shortcut requires compatible task shape between current goal and
remembered run:

1. If **either side has no class tags** (legacy rows) → allow shortcut (weak signal).
2. If **either side has shape tags** → require overlap on at least one **shape**
   class. Modifier-only overlap does **not** count.
3. If **neither side has shape tags** (both modifier-only, rare) → any shared
   modifier tag is enough.

Examples:

| Current goal classes | Remembered run classes | Shortcut? |
|---------------------|------------------------|-----------|
| `aggregateby` | `syncreconcile` | No |
| `rankbymetric` | `rankbymetric`, `lookup` | Yes |
| `comparison`, `timefiltered` | `syncreconcile`, `comparison` | No (shape mismatch) |
| `syncreconcile` | `syncreconcile` | Yes |

---

## Lifecycle

### Ingest (`ingestion.ts`)

On substantive episodic rows:

- `extractGoalClasses(run.goal)` → stored in metadata as `goalClasses` and
  `ftsGoalClasses` (space-separated for FTS indexing).
- Tags are **not** appended to visible episodic content — metadata only.

### Retrieve (`retrieval.ts`)

- FTS query augmented via `augmentGoalQueryForFts(goal)` (goal text + class tags).
- `episodicShortcutMatchesGoal` checks shape affinity before setting
  `perTier.episodicShortcutEligible`.
- Choreography hints (`episodic-choreography.ts`) ride the same eligible row.

### Prompt gating (`goal-classification.ts`)

Separate from episodic affinity:

- **`syncIntent`** — derived from **goal text only** (not memory). Arms sync
  tools and `abi-sync.md`.
- **`dbScore`** — uses `DB_INTENT_GOAL_CLASSES` (shape tags minus generic
  `lookup`) plus operational SQL / tenant keywords. Drives MSSQL prompt sections
  and DB tool filter in `decide-sections.ts`.

Scope discipline (prior goals are history; tooling reflects current goal) lives
in `prompts/default-system.md` and `system-messages/prior-turns.ts` — not in goal
classes.

---

## Context vs execution scope (continuity is preserved)

These changes narrow **what the agent is allowed to auto-execute**, not **what
the model can see**.

| Layer | Still injected? | What changed |
|-------|-----------------|--------------|
| `<prior_turns>` | Yes — full session narrative | Scope text: don't *extend* prior work unless current goal asks; pronouns still resolve to Turn -1 |
| `<prior_results>` | Yes — structured tool payloads with evidence tags | Unchanged |
| `<working_memory>` | Yes — recent session tool trace | Unchanged |
| `<episodic_memory>` body | Yes — prior run summaries (goal, tools, answer) | **Always** rendered when retrieval hits |
| `<semantic_memory>` | Yes — consolidated long-term facts | Unchanged |
| Episodic **shortcut banner** + choreography | Only when goal-class shape matches | Was: blocked by hardcoded tool-name rules. Now: shape affinity only |
| Sync tools in tool list | Only when `syncIntent` on **current goal** | Prevents auto-arming sync from memory alone |
| `abi-sync.md` prompt section | Same as sync tools | Same |

So the LLM still **knows** about prior reconciliation runs, tables found, counts
from earlier turns, and thread narrative. It is not blindfolded. The guardrails
only stop **silently continuing** a different task shape (e.g. jumping from
"how many pipelines?" into `sync_diff_scan` because the thread once reconciled).

Follow-ups that explicitly continue ("now sync that", "also reconcile", "plot
it") still work via pronoun resolution + current goal wording + full memory
injection.

---

## Extending classifiers

Add tags only from **recall-failure evidence** (a shape that should recall
similar goals but does not). Rules:

- Tags must be single FTS tokens (CamelCase, no spaces).
- Prefer tightening shape/modifier split over adding special-case guards.
- Add tests in `packages/server/tests/episodic-goal-class-recall.test.ts`.

---

## Related files

| File | Role |
|------|------|
| `goal-class.ts` | Classifier regexes, affinity, FTS augmentation |
| `episodic-quality.ts` | Shortcut eligibility at ingest (status, tools, trace) |
| `episodic-choreography.ts` | Ordered tool ladder hints on eligible rows |
| `retrieval.ts` | FTS search + affinity gate for shortcut banner |
| `goal-classification.ts` | `syncIntent` / `dbScore` for prompt + tool gating |
| `decide-sections.ts` | Applies classification to sections and tool filter |

Tests: `packages/server/tests/episodic-goal-class-recall.test.ts`,
`packages/server/tests/prompt-token-diet.test.ts`.
