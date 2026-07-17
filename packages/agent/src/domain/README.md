# Domain

**What:** Shared words (`enums/`) and shapes (`types/`).  
**Why:** One vocabulary for core, runtime, tools, and the platform.  
**Next:** Pure decisions → `core/`. Port-backed services → `ports/services/`.

| Folder | Contents |
| ------ | -------- |
| `enums/` | Stable vocabulary (run status, events, tools, …) |
| `types/` | Types, constants, run/step transitions, errors, event builders |
| `tenant/` | Documented process-wide tenant config (ambient allowlist) |

Domain is **types-only** (plus pure value constructors like `createRun` / `runStarted`).
