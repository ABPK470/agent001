# MI:A

A governed AI-agent platform: an LLM-driven execution engine with tools, an
intelligent task router, multi-agent delegation, policy governance, persistent
memory, MSSQL data reconciliation, and a real-time dashboard.

You give it a goal. It picks an execution strategy, calls tools in a loop,
streams every step live, enforces your policies before each action, and returns
a verified answer — or pauses to ask you when it is genuinely stuck.

It also ships an MSSQL data-reconciliation engine (`@mia/sync`) for making one
SQL Server database match another.

## The monorepo at a glance

```
packages/
├── agent/         # The brain: LLM + tools + loop, routing, delegation, recovery, governance
├── server/        # The body: composition root, HTTP API, queue, SQLite, SSE, sandbox
├── sync/          # MSSQL data reconciliation (diff rows + propose + preview + execute)
├── shared-enums/  # Wire-format enums shared across agent / server / ui
├── shared-types/  # Wire-format DTOs shared across agent / server / ui
├── ui/            # React dashboard: chat, live trace, audit, policies, sync, usage
```

One sentence per package:

- **`@mia/agent`** — reusable, server-agnostic execution machinery. No HTTP, no database.
- **`@mia/server`** — the only place that knows about HTTP, SQLite, Docker, and config. It wires concrete adapters into the agent and exposes the REST + SSE API.
- **`@mia/sync`** — an independent MSSQL data-reconciliation engine (SQL Server only). Depends on nothing from the agent.
- **`@mia/shared-enums` / `@mia/shared-types`** — the contract layer every package agrees on.
- **`@mia/ui`** — React dashboard SPA over the REST + SSE API.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full structural deep-dive into each package.

## Quick start (local dev)

Prerequisites: **Node.js ≥ 20**, npm.

```bash
git clone <repo-url> agent001 && cd agent001
npm install
npm run setup                 # creates/validates .env — skips prompts when already complete
npm run dev                   # server :3102 · dashboard :5179
```

`better-sqlite3` is a native addon — after `git pull`, run `npm install` on each machine (do not copy `node_modules`). If bindings fail: `rm -rf node_modules && npm install`.

`npm run setup` reads your existing `.env` and only asks for what is missing. If everything is already set (Databricks host, MSSQL, `MIA_DATA_DIR`, `LLM_PROVIDER`, …), it prints **Setup complete** and exits. Use `npm run setup -- --check` to validate without prompts.

**LLM per machine:** set `LLM_PROVIDER` in `.env` (`copilot-chat` or `databricks`). On each boot the server copies that into SQLite `llm_config` (fresh DB defaults to databricks until `.env` overrides it).

Open [http://localhost:5179](http://localhost:5179).

**`npm run dev` is for monorepo development only** (hot reload, Vite on :5179). On a remote server you run the packaged app with **`npm start`** — see [Hosted deploy](#hosted-deploy-single-bundle-no-monorepo).

| Script | What it runs |
|---|---|
| `npm run setup` | Validate `.env`; prompt only for missing required values (`--check`, `--force`) |
| `npm run dev` | Server + dashboard |
| `npm test` | All workspace test suites (Vitest) |
| `npm run build` | Bundle server → `dist/server.js` + UI → `dist/ui/` |
| `npm run package` | Build + assemble `release/` folder for hosted deploy |
| `npm run lint:arch` | Architecture / doctrine boundary checks (also runs first in `npm run lint`) |

### Minimum `.env` for a laptop (no corp MSSQL)

```bash
PORT=3102
LLM_PROVIDER=copilot-chat      # or databricks / local — see LLM providers below
```

On first server start, entity definitions are seeded automatically from `deploy/sync/artifacts/` when the registry is empty. MSSQL is optional for local chat and policy work.

**Sync requires a separate publish step** — `definitions.bundle.json` is not created by setup or first boot. After the server starts once: **Entity Registry → ⚙ → Publish**. Until then, sync preview/execute is disabled (platform health banner explains). Publish reloads agent vocabulary without a restart.

### Server runtime data (one directory)

**Run `npm run setup` before the first start** — it writes `MIA_DATA_DIR` and other essentials into `.env`, then validates the layout.

If you prefer manual config, set `MIA_DATA_DIR` in `.env` before `npm run dev` or `npm start`. Without it, the server falls back to `~/.mia/` (macOS/Linux: `/Users/you/.mia`, Windows: `C:\Users\you\.mia`) — fine for a quick trial, **wrong for production**.

Everything server-local and not in git lives under that directory:

| File / folder | Purpose |
|---|---|
| `mia.db` | SQLite — entities, sync catalog, **sync run history + plan snapshots**, policies, users |
| `catalog-cache.json` | MSSQL schema graph for agent tools (not sync artifacts) |
| `sync-plans/` | On-disk cache of preview plans (24h); see sync plan persistence below |
| `evidence/` | Signed reconciliation evidence blobs |
| `attachments/` | Uploaded file bytes |
| `browser-contexts/` | Persisted Playwright sessions |
| `vault.key` | Encryption key when `MIA_VAULT_KEY` is unset |

Nothing under this tree is in git.

**Pre-flight gate (runs on every server start):**

| Check | Blocks start? |
|---|---|
| Node 20+ | yes |
| `.env` exists | yes |
| `MIA_DATA_DIR` in `.env` + writable | yes |
| `LLM_PROVIDER` in `.env` | yes |
| Databricks creds when `LLM_PROVIDER=databricks` | yes |
| `MIA_COOKIE_SECRET` (≥16 chars) | yes when `NODE_ENV=production` |
| UI bundle (`dist/ui`) | yes in packaged release |
| MSSQL configured | warn only (optional) |

`npm run setup` / `npm run setup -- --check` use the same rules. `MIA_SKIP_SETUP=1` for CI only.

### Native module errors (`better_sqlite3`, NODE_MODULE_VERSION, bindings file)

**Timeline:** `postinstall` runs `scripts/ensure-native-modules.mjs` to rebuild native addons after install.

**`Could not locate the bindings file`** means `better-sqlite3` was never compiled for your Node (or `node_modules` came from another machine / different Node version).

```bash
rm -rf node_modules
git pull
npm install
npm run dev
```

On macOS if compile fails: `xcode-select --install`, then `npm run rebuild:native`.

**Sync plan persistence (three tiers):**

| Tier | Where | TTL | Role |
|---|---|---|---|
| Memory | in-process | until restart | fast preview → execute in the same session |
| Disk | `sync-plans/{planId}.json` | 24h | survive restart; pruned automatically |
| SQLite | `sync_runs.plan_json` | **no TTL** | audit / History modal — full plan JSON kept for review |

The **1 hour** limit applies only to **execute** (`planTooOldToExecute`): you must re-preview before applying stale row diffs. It does **not** delete history — executed and preview-only runs remain in `mia.db` with `plan_json` for later inspection.

### Corp / hosted install (real MSSQL)

```bash
MSSQL_HOST=...                 # or MSSQL_DATABASES=[{...}] for multi-env
MSSQL_DATABASE=mymi
# optional: MSSQL_DOMAIN, MSSQL_USER, MSSQL_PASSWORD
MSSQL_KNOWLEDGE_FILE=./deploy/mssql/mymi-knowledge.md
MIA_TENANT_CONFIG=./deploy/tenant.json   # agent routing + SQL knobs — see packages/agent/config/TENANT-CONFIG.md
```

Restart the server after changing MSSQL env vars. On boot, the server builds a schema catalog cache at `~/.mia/catalog-cache.json` (or under `MIA_DATA_DIR` when set) when MSSQL is reachable — used by agent tools and Entity Registry “Suggest from schema”. **Shipped artifacts / Entity Registry publish do not build this cache** — use Policies → Platform → Rebuild schema catalog.

**Catalog vs entities:** the catalog cache holds table/FK metadata only. Entity definitions live in SQLite (boot-seeded from artifacts, or imported/edited in Entity Registry). **Publish** (Entity Registry → ⚙ → Publish) writes the runtime bundle at `sync-definitions/published/definitions.bundle.json` — required before sync preview/execute.

Optional one-shot admin instead of first-register-wins:

```bash
MIA_BOOTSTRAP_ADMIN_USERNAME=admin
MIA_BOOTSTRAP_ADMIN_PASSWORD=...
MIA_BOOTSTRAP_ADMIN_DISPLAY_NAME=Admin
```

## First login checklist (admin)

1. **Register or log in** at the welcome screen. The **first local account** becomes admin automatically (`users.is_admin`). Later accounts are non-admin until promoted in **Active Users** (expand a user → Grant admin / Revoke admin).
2. **Platform readiness** (admins): if sync is not ready, a banner explains what is missing — usually publish from Entity Registry, or MSSQL + catalog when targeting SQL Server.
3. **Policies** (widget or modal): LLM provider/model, tool policies, permissions, sync environments (`deploy/sync/sync-environments.json` is the seed — edit in UI after boot). **Policies → Platform**: **Use shipped artifacts** or **Refresh from database** (MSSQL), plus schema catalog rebuild.
4. **Entity registry**: review entities, table scopes, **⚙ → Sync metadata → Flows** (ordered step types — not a separate phase catalog), then **⚙ → Publish** when you change definitions.
5. **Env sync** widget: confirm environments appear and a test preview works against MSSQL.

See [deploy/sync/ENTITY-REGISTRY.md](deploy/sync/ENTITY-REGISTRY.md) for entity vs flow vs publish workflow.

## Regenerating deploy artifacts

**On a deployed server (recommended):** Policies → Platform → **Refresh from database** (requires MSSQL in `.env`). This regenerates `deploy/sync/artifacts/` from live MyMI and imports into SQLite.

**Use shipped artifacts** loads the bundled release files without touching MSSQL.

**CLI (repo dev):** run from repo root with MSSQL reachable:

```bash
# Rebuild all deploy/sync artifacts from legacy MyMI pipelines
node deploy/sync/generators/refresh-from-legacy.mjs --connection uat --force
```

Offline metadata only (no MSSQL): see [deploy/sync/README.md](deploy/sync/README.md).

After regenerating artifacts (UI or CLI): **Entity Registry → Publish**.

## Hosted deploy (single bundle, no monorepo)

From the repo (build machine):

```bash
npm install
npm run package          # builds dist/server.js + assembles release/
```

On the **target server** (no monorepo, no `npm run dev`):

```bash
cd release
npm install              # native/runtime deps only (better-sqlite3, mssql, …)
cp .env.example .env     # optional seed — wizard will merge into it
npm run setup            # required first time — data dir, LLM, optional MSSQL
npm start                # serves dashboard + API on PORT (default 3102)
```

Copy the whole `release/` folder plus your `.env`. Runtime needs **Node ≥ 20** and the copied `deploy/` + `sync-definitions/` trees (generators are optional on the host — only needed to refresh artifacts from MyMI).

**Do not use `npm run dev` on a remote server** — that starts Vite dev servers and the monorepo watcher. Production is **`npm start`** (bundled `dist/server.js` + static UI).

Dev loop without packaging (repo checkout on the server): `npm run build && MIA_PACKAGE_ROOT=1 node dist/server.js` from repo root (still uses `deploy/` and `sync-definitions/` beside `dist/`).

## Entity validation — when predicates are checked

| When | Where | What runs |
|---|---|---|
| **Save entity** | Entity Registry → Edit modal → Save | `POST /api/entity-registry/entities` → `validateEntityDefinition()` (scopes, tables, SCD2 refs) + cross-ref checks. Failures return **422** in the UI. |
| **Import YAML/JSON** | Entity Registry import | Same validator before write (dry-run available). |
| **Publish** | Entity Registry **⚙ → Publish** | `publishSyncDefinitionsFromDb()` re-validates every entity; invalid definitions are **skipped** with errors in the response. Writes `sync-definitions/published/definitions.bundle.json`. |
| **Boot seed** | Server start | Seeds empty `entity_defs` from deploy artifacts; runs `validateEntityDefinition()` per entity. |

The edit modal only checks **form basics** client-side (root table, id column, reason, etc.). **Scope predicates** (`{id}` / `{ids}`, no unsafe SQL, no review placeholders) are enforced on **server save** and again on **publish**.

Example scope kinds: **rootPk** (`tableId = {id}`) or **sql** (e.g. `gate.jsonSchema` subquery scoped to a `gate.MetaTable` instance). Operators pick the entity **instance** at sync time; admins author predicates in the Tables section of the edit modal.

## LLM providers

| Provider | Auth | `LLM_MODEL` means | Default |
|---|---|---|---|
| **Databricks** (default) | `DATABRICKS_*` in `.env` | Serving endpoint name | `databricks-gpt-5-4` |
| **Copilot Chat** | Device Flow — no env creds | Model id | `gpt-5.4` |

Set `LLM_PROVIDER` and optionally `LLM_MODEL` in `.env` — copied into SQLite on every boot.
You can also change provider/endpoint at runtime from the UI (Policies → Model).

## How it works

The foundation is **LLM + Tools + Loop**: the model decides what to do, a tool
executes it, the result feeds back, and the loop repeats until a final answer.
Every tool call passes through governance (policy check → audit log → step
tracking → domain events streamed live over SSE).

**Routing — the agent picks a strategy before it starts.** Each goal is scored
and sent down the cheapest lane that can satisfy it:

| Lane | When | How |
|---|---|---|
| **Direct** | Conversation, lookups, single-file edits | Plain tool loop, minimal overhead |
| **Planner** | Multi-step or multi-specialist work | Structured plan → DAG → per-step verification → repair |

**Delegation.** An agent can spawn child agents via `delegate` (sequential) or
`delegate_parallel` (concurrent). Children share the parent's abort signal and
queue budget and talk to each other with `send_message` / `check_messages`.
Depth is bounded.

**Kill.** Any running tool call can be killed from the UI. The underlying
process — shell, HTTP request, browser, SQL query — is actually terminated.

**Recovery.** Runs checkpoint their state. If the server crashes mid-run, the
run auto-resumes from the last checkpoint on the next start.

## Tools

Tools are registered in `packages/server/src/api/runs/tooling/registry.ts`. Each agent
whitelist picks a subset; the live catalog (names + descriptions) is always:

```bash
curl http://localhost:3102/api/tools
```

### Workspace

| Tool | Description |
|---|---|
| `read_file` / `write_file` / `append_file` | Read and write files (sandboxed to the workspace) |
| `replace_in_file` | Targeted string replacement within a file |
| `list_directory` / `search_files` | List directories · grep across files |

### Shell & network

| Tool | Description |
|---|---|
| `run_command` | Shell command (abort-aware, Docker or host) |
| `fetch_url` | HTTP fetch, HTML reduced to readable text |

### MSSQL & schema catalog

Requires MSSQL env vars and a built schema catalog (`~/.mia/catalog-cache.json` by default, or under `MIA_DATA_DIR`).

| Tool | Description |
|---|---|
| `search_catalog` | **Primary navigation** — keyword / table / lineage / join search over the in-memory catalog graph (no SQL on the hot path) |
| `explore_mssql_schema` | Exact columns, keys, and types for a table or schema (after `search_catalog` identifies candidates) |
| `profile_data` | Row counts, cardinality, nulls, top values — run before heavy joins |
| `discover_relationships` | FK graph and join paths between tables |
| `inspect_definition` | View/proc/function definition text and dependency map |
| `query_mssql` | Execute read-only T-SQL (guarded; results may be truncated) |
| `export_query_to_file` | Run a query and write full results to a workspace file (escape hatch when inline output is clipped) |

See [packages/agent/MSSQL-MECHANICS.md](packages/agent/MSSQL-MECHANICS.md) for the recommended catalog → schema → profile → query workflow.

### Data reconciliation (`@mia/sync`)

| Tool | Description |
|---|---|
| `list_environments` | List configured sync environments (source/target rings) |
| `list_sync_definitions` | List published entity sync definitions |
| `search_sync_entities` | Find syncable entity instances by type, name, or id |
| `resolve_sync_scope` | Resolve which rows an entity instance would touch |
| `compare_catalogs` / `sync_diff_scan` | Diff row sets between environments |
| `sync_preview` / `sync_execute` | Dry-run and apply MSSQL reconciliation plans (execute requires explicit confirmation) |

### Memory, reflection & charts

| Tool | Description |
|---|---|
| `think` | Structured reasoning step (recorded in trace; use sparingly) |
| `note` | Write durable free-form memory for future runs |
| `recall_prior_result` | Fetch a prior tool result from the same thread (by turn or tool-call id) |
| `record_table_verdict` | Persist a structured role classification for an MSSQL table/view (feeds `search_catalog` ranking) |
| `get_chart_specs` | Return chart fenced-block JSON shapes when the catalogue is not already in context |
| `ask_user` | Pause and request human input |

### Coordination & delegation

| Tool | Description |
|---|---|
| `delegate` / `delegate_parallel` | Spawn child agents (sequential / concurrent) |
| `send_message` / `check_messages` / `wait_for_response` | Inter-agent messaging within a run tree |

### Attachments

| Tool | Description |
|---|---|
| `list_attachments` / `read_attachment` | List and read files attached to the current thread |
| `import_attachment` / `promote_attachment` | Import an attachment into the workspace or promote it for reuse |

## Identity & login

Every request is authenticated; there is no anonymous mode. Two paths to a
session:

1. **Local accounts** — `POST /api/auth/register` then `POST /api/auth/login`. Passwords are bcrypt-hashed; the `mia_sid` cookie is an HMAC-signed opaque session id, and identity is re-resolved against the `users` table on every request, so revoking a session in the DB invalidates in-flight cookies immediately.
2. **SSO header** — set a reverse-proxy header (`X-Forwarded-User`, `X-Remote-User`, …); first contact provisions a `users` row (`source='sso'`) and mints a session.

Admin status is the `users.is_admin` column. The first registered local user is admin; promote others via **Active Users** widget (expand row → Grant admin). API: `PATCH /api/admin/users/:upn/admin` with `{ "isAdmin": true }`. Key environment variables:

| Env var | Default | Purpose |
|---|---|---|
| `MIA_SESSION_SECRET` | dev-only fallback | HMAC key for the session cookie. **Required in production.** |
| `MIA_ALLOW_LOCAL_REGISTRATION` | `1` outside prod / `0` in prod | Toggles `POST /api/auth/register`. |
| `MIA_BOOTSTRAP_ADMIN_USERNAME` / `_PASSWORD` / `_DISPLAY_NAME` | unset | When set together, provisions exactly one admin on first boot if the `users` table is empty. |

## Governance

Policy rules are evaluated before every tool call. Effects: `allow` ·
`require_approval` · `deny`.

```bash
# Require approval before any file write
curl -X POST http://localhost:3102/api/policies \
  -H "Content-Type: application/json" \
  -d '{ "name": "approve_writes", "effect": "require_approval", "condition": "action:write_file" }'
```

## API surface

| Area | Representative endpoints |
|---|---|
| **Agents** | `GET/POST /api/agents`, `POST /api/agents/:id/runs`, `GET /api/tools` |
| **Runs** | `GET/POST /api/runs`, `GET /api/runs/:id`, `POST /api/runs/:id/{cancel,resume,rerun,respond,kill-tool}`, `GET /api/runs/:id/trace` |
| **Workspace diff** | `GET /api/runs/:id/workspace-diff`, `POST /api/runs/:id/workspace-diff/apply` |
| **Config** | `GET/PUT /api/llm`, `GET/POST/DELETE /api/policies`, `GET /api/usage`, `GET/PUT /api/workspace` |
| **Sync** | `GET /api/sync/environments`, sync definitions, proposals, approvals |
| **Realtime** | `GET /api/events/stream` (SSE) |

## License

MIT
