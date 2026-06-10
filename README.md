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
└── ui-term/       # Terminal-style UI variant (same backend, two-pane TUI)
```

One sentence per package:

- **`@mia/agent`** — reusable, server-agnostic execution machinery. No HTTP, no database.
- **`@mia/server`** — the only place that knows about HTTP, SQLite, Docker, and config. It wires concrete adapters into the agent and exposes the REST + SSE API.
- **`@mia/sync`** — an independent MSSQL data-reconciliation engine (SQL Server only). Depends on nothing from the agent.
- **`@mia/shared-enums` / `@mia/shared-types`** — the contract layer every package agrees on.
- **`@mia/ui` / `@mia/ui-term`** — two independent React single-page apps over the same API.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full structural deep-dive into each package.

## Quick start

```bash
npm install
npm run dev      # server :3102 · dashboard :5179 · terminal UI :5180
npm test
```

Then open [http://localhost:5179](http://localhost:5179).

| Script | What it runs |
|---|---|
| `npm run dev` | Server + dashboard + terminal UI together |
| `npm run dev:classic` | Server + dashboard only |
| `npm run dev:term` | Server + terminal UI only |
| `npm test` | All workspace test suites (Vitest) |
| `npm run build` | Production bundle |
| `npm run lint:arch` | Architecture / doctrine boundary checks |

## LLM providers

| Provider | Auth | Default model |
|---|---|---|
| **Copilot Chat** (default) | GitHub Device Flow — no env needed | gpt-5.4 |
| **Databricks** | M2M credentials in `.env` | workspace-configured |
| **Local / OpenAI-compatible** (Ollama, LM Studio, …) | `LLM_BASE_URL`, `LLM_API_KEY`, `MODEL` | llama3 |

The provider is stored in the database and hot-swappable at runtime from the UI
(Policies → Model) — no restart required.

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
| **Coherent generation** | Multi-file builds (games, UIs, scripts) | One call generates all files as a bundle; no placeholders allowed; verifier + repair loop follows |
| **Planner** | Parallel or multi-specialist work | Structured plan → DAG → per-step verification → repair |

**Delegation.** An agent can spawn child agents via `delegate` (sequential) or
`delegate_parallel` (concurrent). Children share the parent's abort signal and
queue budget and talk to each other with `send_message` / `check_messages`.
Depth is bounded.

**Kill.** Any running tool call can be killed from the UI. The underlying
process — shell, HTTP request, browser, SQL query — is actually terminated.

**Recovery.** Runs checkpoint their state. If the server crashes mid-run, the
run auto-resumes from the last checkpoint on the next start.

## Tools

| Tool | Description |
|---|---|
| `read_file` / `write_file` / `append_file` | Read and write files (sandboxed to the workspace) |
| `replace_in_file` | Targeted string replacement within a file |
| `list_directory` / `search_files` | List directories · grep across files |
| `run_command` | Shell command (abort-aware, Docker or host) |
| `fetch_url` | HTTP fetch, HTML reduced to readable text |
| `browse_web` | Persistent stealth Playwright session — navigate, click, fill, upload, switch tabs/iframes |
| `browser_auto_login` | Vault-backed sign-in: types stored credentials or a generated TOTP into a live session |
| `browser_human_handoff` | Mints a noVNC URL so a human can clear a CAPTCHA / 2FA, then resumes the agent |
| `web_search` | Real-browser search with auto fail-over across engines |
| `browser_check` | Opens HTML in headless Chromium and reports console errors, JS exceptions, network failures |
| `query_mssql` / `explore_mssql_schema` | Execute T-SQL · inspect schemas, tables, columns |
| `compare_catalogs` / `sync_preview` / `sync_execute` | Diff, dry-run, and apply MSSQL reconciliation plans |
| `delegate` / `delegate_parallel` | Spawn child agents (sequential / concurrent) |
| `send_message` / `check_messages` | Inter-agent messaging within a run tree |
| `ask_user` | Pause and request human input |
| `note` / `recall` | Write to and read from durable memory |

```bash
curl http://localhost:3102/api/tools   # full list with live descriptions
```

## Identity & login

Every request is authenticated; there is no anonymous mode. Two paths to a
session:

1. **Local accounts** — `POST /api/auth/register` then `POST /api/auth/login`. Passwords are bcrypt-hashed; the `mia_sid` cookie is an HMAC-signed opaque session id, and identity is re-resolved against the `users` table on every request, so revoking a session in the DB invalidates in-flight cookies immediately.
2. **SSO header** — set a reverse-proxy header (`X-Forwarded-User`, `X-Remote-User`, …); first contact provisions a `users` row (`source='sso'`) and mints a session.

Admin status is the `users.is_admin` column. Key environment variables:

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
