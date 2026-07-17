# core

Functional core for server application flow.

This folder is the target home for pure orchestration/decision logic that does
not own long-lived mutable coordinators.

Current examples:

- prompt section gating (`decide-sections.ts`)
- goal intent scoring (`goal-classification.ts` — `syncIntent`, `dbScore`, tool filter)
- system message assembly
- clarification block rendering

## Goal intent vs goal classes

Two related layers — do not conflate them:

| Layer | File | Purpose |
|-------|------|---------|
| **Goal classification** | `goal-classification.ts` | Per-run prompt sections and which tool families are available (`syncIntent`, `dbScore`). `syncIntent` uses goal text only. |
| **Goal classes** | `platform/persistence/memory/goal-class.ts` | Episodic memory task-shape tags and shortcut affinity. Documented in [`memory/README.md`](../../../platform/persistence/memory/README.md). |

Scope discipline (“prior goals are history”) is in agent prompts (`default-system.md`,
`prior-turns.ts`), not in classifiers.
