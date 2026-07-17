# Tools

**What:** Concrete capabilities the agent can call (SQL, files, shell, catalog, …).  
**Why:** The model acts through tools; this folder implements them.  
**Next:** Server registry binds `create*Tool(host)` and passes the list to `Agent`.

| Folder | Purpose |
| ------ | ------- |
| `database/` | MSSQL query, inspector, profiler, relationships |
| `files/` | Read/write/search workspace files |
| `shell-command/` | Run OS commands (deny-rules applied) |
| `catalog/`, `catalog-search/` | Schema catalog |
| `bridge/` | Connector-to-connector moves |
| `delegate/`, `delegate-spawn/` | Sub-agent delegation |
| `_shared/` | Helpers shared by tools |

Import only through `tools/index.ts` (or `@mia/agent`) from outside this folder.
