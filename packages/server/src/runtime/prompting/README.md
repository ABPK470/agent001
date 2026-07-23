# prompting

Pure server decisions that build what the model sees and which tool families
load. This is **not** `@mia/agent`’s package-level `core/`.

Examples:

- prompt section gating (`decide-sections.ts`)
- goal intent scoring (`goal-classification.ts` — `syncIntent`, `dbScore`, tool filter)
- system message assembly
- clarification block rendering

## Goal intent vs goal classes

| Layer | File | Purpose |
|-------|------|---------|
| **Goal classification** | `goal-classification.ts` | Per-run prompt sections and which tool families are available |
| **Goal classes** | `infra/persistence/memory/goal-class.ts` | Episodic memory task-shape tags |

Scope discipline (“prior goals are history”) lives in agent prompts, not here.
