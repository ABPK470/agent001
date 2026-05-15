# MI:A

Governed AI agent platform with multi-agent orchestration, intelligent task routing, and real-time observability.

```
packages/
├── agent/         # LLM loop, tools, planner, governance engine, delegation
├── server/        # Orchestrator, queue, SQLite, REST API, SSE
├── ui/            # React dashboard: chat, trace, audit, policies, usage
├── ui-term/       # Terminal-style UI variant
├── shared-enums/  # Wire-format enums shared across agent/server/ui
└── shared-types/  # Wire-format DTOs shared across agent/server/ui
```

## Quick start

```bash
npm install
npm run dev    # backend :3102 · UI :5179
npm test
```

Open [http://localhost:5179](http://localhost:5179).

## LLM providers

| Provider | Env / auth | Default model |
|---|---|---|
| **Copilot Chat** (default) | GitHub Device Flow (no env needed) | gpt-5.4 |
| **Databricks** | M2M creds in `.env` | (workspace-configured) |
| **Local** (Ollama / LM Studio / any OpenAI-compatible) | `LLM_BASE_URL`, `LLM_API_KEY`, `MODEL` | llama3 |

Hot-swap provider at runtime via the UI (Policies → Model) — no restart needed.

## How it works

The foundation is **LLM + Tools + Loop**: the LLM decides what to do, tools execute it, results feed back, repeat until a final answer. Every tool call passes through the governance layer (policy check → audit log → step tracking → domain events streamed live via SSE).

**Routing — five execution lanes.** Before each run the system scores the goal and picks the right strategy:

| Lane | When | How |
|---|---|---|
| **Direct** | Conversational, single-file edits, lookups | Plain tool loop, minimal overhead |
| **Coherent generation** | Multi-file builds (games, UIs, scripts) | One LLM call generates all files as a bundle; no placeholders allowed; verifier + repair loop runs after |
| **Planner** | Parallel or multi-specialist tasks | Structured plan → DAG pipeline → per-step verification → repair |

**Delegation.** An agent can spawn child agents via `delegate` (sequential) or `delegate_parallel` (concurrent). Children share the parent's abort signal and queue budget; they communicate with `send_message` / `check_messages`. Depth limit: 3.

**Kill.** Any running tool call can be killed from the UI. The underlying process (shell, HTTP request, browser, SQL query) is actually terminated — not just flagged.

**Recovery.** Runs checkpoint their state. If the server crashes mid-run, the run auto-resumes from the last checkpoint on next start.

## Tools

| Tool | Description |
|---|---|
| `read_file` | Read a file (path-sandboxed to workspace) |
| `write_file` | Write / create a file |
| `append_file` | Append content to a file |
| `replace_in_file` | Targeted string replacement within a file |
| `list_directory` | List directory contents |
| `search_files` | Grep across files with text or regex |
| `run_command` | Shell command (abort-signal aware, Docker or host) |
| `fetch_url` | HTTP fetch, HTML stripped to readable text |
| `browse_web` | Persistent stealth Playwright session — navigate, click, fill, upload, switch tabs/iframes, intercept requests |
| `browser_auto_login` | Vault-backed sign-in: types stored credentials or generates a TOTP code into a live `browse_web` session |
| `browser_human_handoff` | Mints a noVNC URL so the user can take over the live browser to clear a CAPTCHA / non-TOTP 2FA, then resumes the agent |
| `web_search` | Real-browser search via DuckDuckGo / Bing / Google with auto fail-over on CAPTCHA |
| `browser_check` | Open an HTML file in headless Chromium (Playwright); report console errors, JS exceptions, network failures |
| `query_mssql` | Execute T-SQL against a configured SQL Server |
| `explore_mssql_schema` | Inspect SQL Server schemas, tables, and columns |
| `delegate` | Spawn a child agent for a sub-task (sequential) |
| `delegate_parallel` | Spawn multiple child agents concurrently |
| `send_message` | Publish a message to other agents in the run tree |
| `check_messages` | Read messages from sibling/parent agents |
| `ask_user` | Pause and request human input |

```bash
curl http://localhost:3102/api/tools   # full list with descriptions
```

## Identity & login

Every request is authenticated. There is no anonymous mode.

Two paths to a session:

1. **Local accounts** — `POST /api/auth/register` then `POST /api/auth/login`. Passwords are bcrypt-hashed; the cookie (`mia_sid`) is an HMAC-signed opaque session id and identity is JOIN-resolved against the `users` table on every request, so revoking a session in the DB invalidates all in-flight cookies instantly.
2. **SSO header** — set a reverse-proxy header (`From-User-Name`, `X-User-Name`, `X-Forwarded-User`, or `X-Remote-User`); the first contact provisions a `users` row (`source='sso'`) and mints a session.

Admin status is the `users.is_admin` column. There is no admin cookie, no access-code login, no `MIA_ADMIN_UPNS` whitelist.

| Env var | Default | Purpose |
|---|---|---|
| `MIA_SESSION_SECRET` | dev-only fallback | HMAC key for the `mia_sid` cookie. **Required in production.** |
| `MIA_ALLOW_LOCAL_REGISTRATION` | `1` outside production / `0` in production | Toggles `POST /api/auth/register`. |
| `MIA_BOOTSTRAP_ADMIN_USERNAME` | _(unset)_ | If set together with the two below, the server provisions exactly one admin user on first boot when the `users` table is empty. |
| `MIA_BOOTSTRAP_ADMIN_PASSWORD` | _(unset)_ | Initial password for the bootstrap admin. |
| `MIA_BOOTSTRAP_ADMIN_DISPLAY_NAME` | _(unset)_ | Display name for the bootstrap admin. |

> **v19 schema is destructive.** The migration drops legacy identity tables (sessions, runs, attachments, browser-*, notifications, …) and recreates them with `users(upn)` as a hard FK. Existing local databases will be wiped except for `llm_config` and `schema_meta`. After upgrade, every user re-registers (or is provisioned via SSO on first request); the bootstrap env-vars give you exactly one survivor.

## Governance

Policy rules are evaluated before every tool call:

```bash
# Deny shell commands
curl -X POST http://localhost:3102/api/policies \
  -H "Content-Type: application/json" \
  -d '{ "name": "no_shell", "effect": "deny", "condition": "action:run_command" }'

# Require approval before any file write
curl -X POST http://localhost:3102/api/policies \
  -H "Content-Type: application/json" \
  -d '{ "name": "approve_writes", "effect": "require_approval", "condition": "action:write_file" }'
```

Effects: `allow` · `require_approval` · `deny`

## API

### Agents
| Method | Path | |
|---|---|---|
| `GET` / `POST` | `/api/agents` | List / create agent definitions |
| `GET` / `PUT` / `DELETE` | `/api/agents/:id` | Read / update / delete |
| `POST` | `/api/agents/:id/runs` | Start a run scoped to this agent's config |
| `GET` | `/api/tools` | List all available tools |

### Runs
| Method | Path | |
|---|---|---|
| `GET` / `POST` | `/api/runs` | List / start |
| `GET` | `/api/runs/:id` | Detail (steps, audit, logs) |
| `POST` | `/api/runs/:id/cancel` | Cancel |
| `POST` | `/api/runs/:id/resume` | Resume from checkpoint |
| `POST` | `/api/runs/:id/rerun` | Fresh run with same goal + agent |
| `POST` | `/api/runs/:id/respond` | Respond to a pending `ask_user` |
| `POST` | `/api/runs/:id/kill-tool` | Kill a specific tool call |
| `GET` | `/api/runs/:id/trace` | Execution trace |
| `GET` | `/api/runs/:id/workspace-diff` | View pending isolated file diff |
| `POST` | `/api/runs/:id/workspace-diff/apply` | Apply approved diff to workspace |
| `GET` | `/api/runs/active` | Active run IDs |
| `GET` | `/api/queue` | Queue stats |

### Config
| Method | Path | |
|---|---|---|
| `GET` / `PUT` | `/api/llm` | LLM config (hot-swap) |
| `GET` / `POST` / `DELETE` | `/api/policies` | Policy rules |
| `GET` | `/api/usage` | Token usage |
| `GET` / `PUT` | `/api/workspace` | Agent workspace path |
| `DELETE` | `/api/data` | Reset transactional data (keeps policies + layouts) |

---

See [ARCHITECTURE.md](ARCHITECTURE.md) for a full technical deep-dive.

MIT

