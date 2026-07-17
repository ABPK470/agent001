# Domain

**What:** Shared words (`enums/`), shapes (`types/`), and domain services (`services/`).  
**Why:** Core, runtime, and tools must mean the same things.  
**Next:** Prefer importing through `domain/index.ts` or `@mia/agent`.

| Folder | Contents |
| ------ | -------- |
| `enums/` | Stable vocabulary (run status, events, tools, …) |
| `types/` | Types, constants, run/step transitions, errors, memory adapters |
| `services/` | Policy evaluator, audit, learner, domain events |
