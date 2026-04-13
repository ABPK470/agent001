# agent001

Governed AI agent platform with multi-agent orchestration, intelligent task routing, and real-time observability.

```
packages/
├── agent/   # LLM loop, tools, planner, governance engine, delegation
├── server/  # Orchestrator, queue, SQLite, REST API, WebSocket
└── ui/      # React dashboard: chat, trace, audit, policies, usage
```

## Quick start

```bash
npm install
npm run dev    # backend :3001 · UI :5179
npm test
```

Open [http://localhost:5179](http://localhost:5179).

## LLM providers

| Provider | Env var | Default model |
|---|---|---|
| **GitHub Copilot** (default) | `GITHUB_TOKEN` | gpt-4o |
| **OpenAI** | `OPENAI_API_KEY` | gpt-4o |
| **Anthropic** | `ANTHROPIC_API_KEY` | claude-sonnet-4-20250514 |
| **Local** (Ollama, LM Studio) | — | llama3 |

Hot-swap provider at runtime via the UI (Policies → Model) — no restart needed.

## How it works

The foundation is **LLM + Tools + Loop**: the LLM decides what to do, tools execute it, results feed back, repeat until a final answer. Every tool call passes through the governance layer (policy check → audit log → step tracking → domain events streamed live via WebSocket).

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
| `browse_web` | Puppeteer browser session (navigate, click, fill, read) |
| `browser_check` | Open an HTML file in headless Chrome; report console errors, JS exceptions, network failures |
| `query_mssql` | Execute T-SQL against a configured SQL Server |
| `explore_mssql_schema` | Inspect SQL Server schemas, tables, and columns |
| `delegate` | Spawn a child agent for a sub-task (sequential) |
| `delegate_parallel` | Spawn multiple child agents concurrently |
| `send_message` | Publish a message to other agents in the run tree |
| `check_messages` | Read messages from sibling/parent agents |
| `ask_user` | Pause and request human input |

```bash
curl http://localhost:3001/api/tools   # full list with descriptions
```

## Governance

Policy rules are evaluated before every tool call:

```bash
# Deny shell commands
curl -X POST http://localhost:3001/api/policies \
  -H "Content-Type: application/json" \
  -d '{ "name": "no_shell", "effect": "deny", "condition": "action:run_command" }'

# Require approval before any file write
curl -X POST http://localhost:3001/api/policies \
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

See [SYSTEM_ARCHITECTURE.md](docs/SYSTEM_ARCHITECTURE.md) for a full technical deep-dive.

MIT

