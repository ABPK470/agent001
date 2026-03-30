# agent001

A **single-agent platform** where agents are configuration, not code. You build ONE generic runtime, and define agents via configuration — each with its own system prompt, tool set, and personality.

```
┌──────────────────────────────────────────────────────────────────┐
│  User: "Find the 3 largest files in src"                         │
├──────────────────────────────────────────────────────────────────┤
│  Agent Definition (from DB)                                      │
│  ┌────────────────────────────────────────────────────────┐      │
│  │ name: "Universal Agent"                                │      │
│  │ tools: [read_file, write_file, list_directory, ...]    │      │
│  │ systemPrompt: "You are a capable AI agent..."          │      │
│  └────────────────────────────────────────────────────────┘      │
├──────────────────────────────────────────────────────────────────┤
│  Agent Runtime (LLM + Tools + Loop)                              │
│  ┌─────────────┐    ┌───────────────────────────────────────┐    │
│  │  LLM brain  │───→│ Tool call: list_directory("src")      │    │
│  │ (Copilot /  │    └──────────────────┬────────────────────┘    │
│  │  OpenAI /   │                       │                         │
│  │  Anthropic /│◄── result ────────────┘                         │
│  │  Local)     │                                                 │
│  └─────────────┘                                                 │
├──────────────────────────────────────────────────────────────────┤
│  Governance Substrate (policies, audit, tracking)                │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────┐            │
│  │  Policy  │ │  Audit   │ │   Run    │ │  Event  │            │
│  │  Engine  │ │  Trail   │ │Tracking  │ │   Bus   │            │
│  │          │ │          │ │          │ │         │            │
│  │ Can this │ │ Who did  │ │ Full run │ │WebSocket│            │
│  │ tool run?│ │ what,    │ │ + steps  │ │real-time│            │
│  │ Denied?  │ │ when?    │ │ in SQLite│ │ streams │            │
│  └──────────┘ └──────────┘ └──────────┘ └─────────┘            │
└──────────────────────────────────────────────────────────────────┘
```

**Every tool call** the agent makes goes through the governance engine:

1. **Policy check** — Can this tool run? Should it require human approval? Hard deny?
2. **Audit log** — Immutable record: actor, action, timestamp, arguments, result
3. **Step tracking** — Each tool call is a Step in a Run with full lifecycle
4. **Domain events** — `step.started`, `step.completed`, `step.failed` — real-time via WebSocket
5. **Execution metrics** — Token usage, per-tool stats, run history

```
packages/
├── agent/    # The AI core: LLM clients, tools, agent loop, governance engine
├── server/   # Backend: orchestrator, SQLite, REST API, WebSocket, channels
└── ui/       # React dashboard: chat, trace, audit, policies, agent management
```

## Quick start

```bash
# Prerequisites: Node.js >= 20
npm install

# Start everything (backend on 3001, UI on 5179)
npm run dev

# Run tests (18 agent governance + 30 server channels)
npm test
```

Open [http://localhost:5179](http://localhost:5179) — the dashboard connects automatically.

### LLM providers

Configure the LLM in the dashboard (Policies → Model tab), or set env vars:

| Provider | Env var | Default model |
|---|---|---|
| **GitHub Copilot** (default) | `GITHUB_TOKEN` | gpt-4o |
| **OpenAI** | `OPENAI_API_KEY` | gpt-4o |
| **Anthropic** | `ANTHROPIC_API_KEY` | claude-sonnet-4-20250514 |
| **Local** (Ollama, LM Studio) | — | llama3 |

The LLM provider can be hot-swapped at runtime via the UI or API — no restart needed.

---

## Architecture — Pattern C: Agents as Configuration

The core insight: **agents are data, not code.** Each agent is defined by a row in the database:

| Field | Purpose |
|---|---|
| `name` | Human-readable label ("Code Reviewer", "Research Assistant") |
| `description` | What this agent is for |
| `systemPrompt` | The agent's personality and instructions |
| `tools` | Subset of available tools (e.g., `["read_file", "think"]`) |

A single generic agent runtime executes _any_ agent definition. To create a new agent, you add a row — not code.

### Agent definitions API

```bash
# List all agents
curl http://localhost:3001/api/agents

# Create a read-only code reviewer
curl -X POST http://localhost:3001/api/agents \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Code Reviewer",
    "description": "Reviews code without modifying files",
    "systemPrompt": "You are a senior code reviewer. Analyze code for bugs, style issues, and improvements. Never modify files — only read and report.",
    "tools": ["read_file", "list_directory", "think"]
  }'

# Start a run with that agent
curl -X POST http://localhost:3001/api/agents/<id>/runs \
  -H "Content-Type: application/json" \
  -d '{ "goal": "Review src/orchestrator.ts for potential issues" }'
```

### Tool registry

Six tools are available. Each agent definition picks a subset:

| Tool | What it does |
|---|---|
| `read_file` | Read a local file |
| `write_file` | Write / create files |
| `list_directory` | List directory contents |
| `run_command` | Run a shell command (30s timeout) |
| `fetch_url` | Fetch a URL, strip HTML, return text |
| `think` | Chain-of-thought reasoning scratchpad |

```bash
# List all available tools
curl http://localhost:3001/api/tools
```

### The governance wrapper

Every tool call goes through the governance engine before execution:

```typescript
function governTool(tool: Tool, services: EngineServices, runState: RunState): Tool {
  return {
    ...tool,
    async execute(args) {
      // 1. Policy check — can this tool run?
      const blocked = await services.policyEvaluator.evaluatePreStep(run, step)
      if (blocked) return "BLOCKED: " + blocked

      // 2. Audit: tool invoked
      await services.auditService.log({ actor, action: "tool.invoked", ... })

      // 3. Execute the actual tool
      const result = await tool.execute(args)

      // 4. Complete step + record metrics + emit events
      completeStep(step, { result, durationMs })
      await services.auditService.log({ actor, action: "tool.completed", ... })

      return result
    }
  }
}
```

The agent class itself never changes. Tool wrapping is the integration point — the **Decorator pattern** at architecture level.

### Policies

Policies are data-driven rules evaluated before each tool executes:

```bash
# Block shell commands entirely
curl -X POST http://localhost:3001/api/policies \
  -H "Content-Type: application/json" \
  -d '{ "name": "no_shell", "effect": "deny", "condition": "action:run_command" }'

# Require approval for file writes
curl -X POST http://localhost:3001/api/policies \
  -H "Content-Type: application/json" \
  -d '{ "name": "approve_writes", "effect": "require_approval", "condition": "action:write_file" }'
```

Effects: `allow` (proceed), `require_approval` (block + log), `deny` (hard reject + log).

---

## The dashboard

A React dashboard with configurable widgets. All data updates in real-time via WebSocket.

| Widget | What it shows |
|---|---|
| **Agent Chat** | Chat interface — type goals, see responses. Agent picker for switching agents. |
| **Agent Trace** | Step-by-step execution trace with thinking, tool calls, and results |
| **Run Status** | Current run progress and state |
| **Run History** | Past agent executions |
| **Audit Trail** | Complete action audit log |
| **Step Timeline** | Visual timeline of tool calls |
| **Tool Stats** | Per-tool execution metrics |
| **Live Logs** | Real-time log stream |

### Management modals

- **Agents** — Create, edit, delete agent definitions. Each agent gets a name, description, system prompt, and tool selection.
- **Policies** — Per-tool governance rules (allow / deny / require approval). Workspace path configuration. Data reset.
- **Model** — LLM provider picker (Copilot, OpenAI, Anthropic, Local) with model, API key, and base URL fields. Hot-swap at runtime.
- **Usage** — Token consumption per run, total usage metrics.

---

## Messaging Channels (WhatsApp & Messenger)

The server ships with a production-ready message routing layer. When a user sends a message on WhatsApp or Messenger, it triggers an agent run and the reply is delivered back automatically, with per-conversation FIFO queuing and exponential-backoff retry.

### Architecture

```
User (WhatsApp / Messenger)
  │
  ▼ POST /webhooks/{whatsapp,messenger}
┌─────────────────────┐
│   Webhook handler   │  HMAC-SHA256 signature validation (reject forgeries)
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│   MessageRouter     │  finds/creates Conversation, starts agent run
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│   Agent run         │  LLM + tools, full governance
└────────┬────────────┘
         │ answer
         ▼
┌─────────────────────┐
│   MessageQueue      │  per-(channel, recipient) FIFO serialisation
└────────┬────────────┘
         │ retry with backoff (1s → 60s, ×2, jitter, 5 attempts)
         ▼
  Platform API (Graph API v21.0)
```

### Prerequisites

You need a **Meta for Developers** app with the relevant product added:

1. Go to [developers.facebook.com](https://developers.facebook.com) → **My Apps → Create App**
2. Choose **Business** type
3. Add the **WhatsApp** and/or **Messenger** products

Your server must be publicly reachable (use [ngrok](https://ngrok.com) for local dev):

```bash
ngrok http 3001
# Copy the https://xxx.ngrok.io URL
```

---

### WhatsApp setup

#### 1 — Collect credentials from Meta dashboard

| Field | Where to find it |
|---|---|
| **Phone Number ID** | WhatsApp → API Setup → Phone number ID |
| **Access Token** | WhatsApp → API Setup → Temporary or permanent token |
| **App Secret** | App Settings → Basic → App Secret |
| **Verify Token** | Any string you choose — you'll enter it in both places |

#### 2 — Register the channel with agent001

```bash
curl -X POST http://localhost:3001/api/channels \
  -H "Content-Type: application/json" \
  -d '{
    "type": "whatsapp",
    "platformId": "<Phone_Number_ID>",
    "accessToken": "<Access_Token>",
    "appSecret": "<App_Secret>",
    "verifyToken": "<your_verify_token>"
  }'
```

#### 3 — Configure the webhook in Meta dashboard

- **Callback URL:** `https://your-domain/webhooks/whatsapp`
- **Verify Token:** same string you used above
- **Webhook fields:** subscribe to `messages`

Click **Verify and Save**. Meta will call `GET /webhooks/whatsapp?hub.verify_token=...` — the server returns the challenge automatically.

---

### Messenger setup

#### 1 — Collect credentials

| Field | Where to find it |
|---|---|
| **Page ID** | Your Facebook Page → About → Page ID |
| **Page Access Token** | Messenger → API Setup → Generate token for your page |
| **App Secret** | App Settings → Basic → App Secret |
| **Verify Token** | Any string you choose |

#### 2 — Register the channel

```bash
curl -X POST http://localhost:3001/api/channels \
  -H "Content-Type: application/json" \
  -d '{
    "type": "messenger",
    "platformId": "<Page_ID>",
    "accessToken": "<Page_Access_Token>",
    "appSecret": "<App_Secret>",
    "verifyToken": "<your_verify_token>"
  }'
```

#### 3 — Configure the webhook

- **Callback URL:** `https://your-domain/webhooks/messenger`
- **Verify Token:** same string you used above
- **Webhook fields:** subscribe to `messages`

---

### Channel management API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/channels` | List registered channels |
| `POST` | `/api/channels` | Register / update a channel |
| `DELETE` | `/api/channels/:type` | Remove a channel |
| `GET` | `/api/conversations` | List all conversations |
| `GET` | `/api/conversations/:id/messages` | Message history for a conversation |
| `GET` | `/api/delivery/stats` | Delivery success/failure stats |

### Retry policy

Failed deliveries are retried automatically:

| Attempt | Min delay | Max delay |
|---|---|---|
| 1 | 1s | 1.5s |
| 2 | 2s | 3s |
| 3 | 4s | 6s |
| 4 | 8s | 12s |
| 5 | 16s | 24s |

- `429` (rate limited) and `5xx` errors are retried
- `4xx` errors (bad token, bad request) fail immediately — fix credentials and retry manually
- Messages within the same conversation are serialised (no out-of-order replies)

---

## Full API reference

### Agent platform

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check (active runs, channels, queue) |
| `GET` | `/api/workspace` | Current agent workspace path |
| `PUT` | `/api/workspace` | Change agent workspace |
| `DELETE` | `/api/data` | Reset transactional data (keeps policies + layouts) |

### Agents

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/agents` | List all agent definitions |
| `POST` | `/api/agents` | Create agent definition |
| `GET` | `/api/agents/:id` | Get agent definition |
| `PUT` | `/api/agents/:id` | Update agent definition |
| `DELETE` | `/api/agents/:id` | Delete agent (default is protected) |
| `POST` | `/api/agents/:id/runs` | Start a run scoped to agent's config |
| `GET` | `/api/tools` | List all available tools in the registry |

### Runs

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/runs` | List all runs |
| `POST` | `/api/runs` | Start a run (optional agentId) |
| `GET` | `/api/runs/:id` | Get run detail (steps, audit, logs) |
| `POST` | `/api/runs/:id/cancel` | Cancel a running agent |
| `POST` | `/api/runs/:id/resume` | Resume from checkpoint |
| `GET` | `/api/runs/active` | List active run IDs |
| `GET` | `/api/runs/:id/trace` | Get rich execution trace |

### Governance & config

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/policies` | List policy rules |
| `POST` | `/api/policies` | Create policy rule |
| `DELETE` | `/api/policies/:name` | Delete policy rule |
| `GET` | `/api/llm` | Get LLM config (provider, model, has key) |
| `PUT` | `/api/llm` | Update LLM config (hot-swap provider) |
| `GET` | `/api/usage` | Token usage stats |

### Dashboard

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/layouts` | List saved layouts |
| `POST` | `/api/layouts` | Save layout |
| `DELETE` | `/api/layouts/:id` | Delete layout |
| `GET` | `/api/dashboard-state` | Get persisted dashboard state |
| `PUT` | `/api/dashboard-state` | Save dashboard state |

---

## Project structure

```
packages/
├── agent/                     # The AI core
│   ├── src/
│   │   ├── types.ts           # Message, Tool, ToolCall, LLMClient interfaces
│   │   ├── agent.ts           # The Agent class — LLM + tool loop
│   │   ├── governance.ts      # Engine integration — wraps tools with audit/policies
│   │   ├── lib.ts             # Library exports for server integration
│   │   ├── logger.ts          # Colored console output
│   │   ├── cli.ts             # CLI entry point (governed + raw modes)
│   │   ├── engine/            # Governance engine (embedded)
│   │   │   ├── models.ts      # Domain entities: Run, Step, state machines
│   │   │   ├── enums.ts       # RunStatus, StepStatus, PolicyEffect
│   │   │   ├── events.ts      # Domain events (runStarted, stepCompleted, ...)
│   │   │   ├── errors.ts      # PolicyViolationError, InvalidTransitionError
│   │   │   ├── interfaces.ts  # Port interfaces (repos, services)
│   │   │   ├── policy.ts      # Rule-based policy evaluator
│   │   │   ├── audit.ts       # Immutable audit service
│   │   │   ├── learner.ts     # Execution stats aggregator
│   │   │   ├── memory.ts      # In-memory adapters (repos, event bus)
│   │   │   └── index.ts       # Engine barrel export
│   │   ├── llm/
│   │   │   ├── openai.ts      # OpenAI function calling (raw fetch)
│   │   │   └── anthropic.ts   # Anthropic tool use (raw fetch)
│   │   └── tools/
│   │       ├── filesystem.ts  # read/write/list with path sandboxing
│   │       ├── shell.ts       # Shell command execution
│   │       ├── fetch-url.ts   # HTTP fetch + HTML stripping
│   │       └── think.ts       # Reasoning tool
│   └── tests/
│       └── governance.test.ts # 18 tests — policies, audit, events, tracking
│
├── server/                    # Backend API + agent orchestrator
│   ├── src/
│   │   ├── index.ts           # Fastify server, routes, WebSocket, startup
│   │   ├── orchestrator.ts    # Agent run lifecycle (start/resume/cancel)
│   │   ├── db.ts              # SQLite persistence (~/.agent001/agent001.db)
│   │   ├── tools.ts           # Tool registry — resolves agent tool subsets
│   │   ├── ws.ts              # WebSocket client management + broadcast
│   │   ├── llm/
│   │   │   ├── registry.ts    # LLM provider factory (Copilot/OpenAI/Anthropic/Local)
│   │   │   └── copilot.ts     # GitHub Copilot LLM client
│   │   ├── channels/          # WhatsApp + Messenger routing layer
│   │   │   ├── types.ts       # ChannelType, InboundMessage, OutboundMessage
│   │   │   ├── whatsapp.ts    # WhatsApp Cloud API, HMAC-SHA256 validation
│   │   │   ├── messenger.ts   # Messenger Send API, HMAC-SHA256 validation
│   │   │   ├── router.ts      # MessageRouter — inbound → agent run → reply
│   │   │   ├── queue.ts       # Per-conversation FIFO queue with retry
│   │   │   ├── retry.ts       # Exponential backoff + jitter
│   │   │   └── store.ts       # SQLite persistence (conversations, queue, configs)
│   │   └── routes/
│   │       ├── agents.ts      # Agent definition CRUD + scoped runs + tools list
│   │       ├── runs.ts        # Run lifecycle (start, cancel, resume, list, detail)
│   │       ├── policies.ts    # Governance policy CRUD
│   │       ├── llm.ts         # LLM config read/write + hot-swap
│   │       ├── usage.ts       # Token usage stats
│   │       ├── layouts.ts     # Dashboard layout persistence
│   │       └── webhooks.ts    # WhatsApp + Messenger webhook endpoints
│   └── tests/
│       └── channels.test.ts   # 30 tests — retry, queue, webhook parsing
│
└── ui/                        # React dashboard
    └── src/
        ├── api.ts             # HTTP client to server API
        ├── store.ts           # Zustand state management
        ├── types.ts           # Frontend type definitions
        ├── components/
        │   ├── AgentEditor.tsx # Agent definition CRUD modal
        │   ├── PolicyEditor.tsx # Governance + workspace + model config modal
        │   ├── Toolbar.tsx    # Top bar (Agents, Usage, Policies buttons)
        │   ├── Logo.tsx       # Robot logo — green eyes online, red offline
        │   └── ...            # Canvas, ViewTabs, WidgetCatalog, WidgetFrame
        └── widgets/
            ├── AgentChat.tsx  # Chat interface with agent picker
            ├── AgentTrace.tsx # Step-by-step execution trace
            ├── AuditTrail.tsx # Complete action audit log
            ├── RunStatus.tsx  # Current run progress
            ├── RunHistory.tsx # Past executions
            ├── StepTimeline.tsx # Visual step timeline
            ├── ToolStats.tsx  # Per-tool metrics
            └── LiveLogs.tsx   # Real-time log stream
```

### Database schema (SQLite)

| Table | Purpose |
|---|---|
| `agent_definitions` | Agent configurations (name, system prompt, tools) |
| `runs` | Agent execution records (goal, status, answer, agent_id) |
| `audit_log` | Immutable action log |
| `checkpoints` | Resume points (messages, iteration) |
| `policy_rules` | Governance rules |
| `llm_config` | Active LLM provider settings |
| `token_usage` | Per-run token consumption |
| `trace_entries` | Rich execution trace data |
| `logs` | Live event stream |
| `layouts` | Dashboard configurations |

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full technical design guide.

MIT
