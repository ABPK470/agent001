# agent001

An AI agent that runs **on** a workflow engine. The agent decides what to do (LLM + tools). The engine provides the substrate: audit trail, governance policies, run tracking, domain events, and execution metrics.

```
┌──────────────────────────────────────────────────────────────────┐
│  User: "Find the 3 largest files in src"                         │
├──────────────────────────────────────────────────────────────────┤
│  Agent (LLM + Tools + Loop)                                      │
│  ┌─────────────┐    ┌───────────────────────────────────────┐    │
│  │ LLM "brain" │───→│ Tool call: read_file("src/agent.ts")  │    │
│  │ (OpenAI /   │    └──────────────────┬────────────────────┘    │
│  │  Anthropic) │                       │                         │
│  │             │◄── result ────────────┘                         │
│  └─────────────┘                                                 │
├──────────────────────────────────────────────────────────────────┤
│  Engine Substrate (governance, audit, tracking)                   │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────┐ ┌────────┐ │
│  │  Policy  │ │  Audit   │ │   Run    │ │  Event  │ │Learner │ │
│  │  Engine  │ │  Trail   │ │Tracking  │ │   Bus   │ │ Stats  │ │
│  │          │ │          │ │          │ │         │ │        │ │
│  │ Can this │ │ Who did  │ │ Full run │ │ Hooks / │ │Success │ │
│  │ tool run?│ │ what,    │ │ + steps  │ │ monitor │ │rate,   │ │
│  │ Approval?│ │ when,    │ │ with     │ │ streams │ │avg     │ │
│  │ Denied?  │ │ result?  │ │ state    │ │         │ │latency │ │
│  └──────────┘ └──────────┘ └──────────┘ └─────────┘ └────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

**Every tool call** the agent makes goes through the engine:

1. **Policy check** — Can this tool run? Should it require human approval? Hard deny?
2. **Audit log** — Immutable record: actor, action, timestamp, arguments, result
3. **Step tracking** — Each tool call is a Step in a WorkflowRun with full lifecycle
4. **Domain events** — `step.started`, `step.completed`, `step.failed` etc. for monitoring
5. **Execution metrics** — Duration, success/failure rate per tool, fed to the Learner

```
packages/
├── engine/   # The substrate: audit, policies, run tracking, events, learner
└── agent/    # The AI: LLM clients, tools, agent loop, governance integration
```

## Quick start

```bash
# Prerequisites: Node.js >= 20
npm install

# Run all tests (71 engine + 18 agent governance)
npm test -w packages/engine && npm test -w packages/agent

# Run the agent with governance (default mode)
OPENAI_API_KEY=sk-... npm start -w packages/agent

# Or with Anthropic
ANTHROPIC_API_KEY=sk-ant-... npm start -w packages/agent

# One-shot mode
OPENAI_API_KEY=sk-... npm start -w packages/agent -- "List files in src and summarize each"

# Raw mode (no governance — bare agent loop, no audit/policies)
AGENT_MODE=raw OPENAI_API_KEY=sk-... npm start -w packages/agent
```

After each governed run, you get a **governance report**:

```
══════════════════════════════════════════════════════════
  GOVERNANCE REPORT
══════════════════════════════════════════════════════════

  Run ID:     a1b2c3d4-...
  Status:     completed
  Steps:      5 tool calls
  Started:    2026-03-26T14:30:00.000Z
  Completed:  2026-03-26T14:30:12.345Z (12.3s)

  ── Steps ──
  ✅ list_directory (#0) → completed (23ms)
  ✅ read_file (#1) → completed (4ms)
  ✅ read_file (#2) → completed (3ms)
  ✅ think (#3) → completed (0ms)
  ✅ read_file (#4) → completed (5ms)

  ── Tool Stats ──
  list_directory: 1 calls, avg 23ms, 0 failures
  read_file: 3 calls, avg 4ms, 0 failures
  think: 1 calls, avg 0ms, 0 failures

  ── Audit Trail ──
  [14:30:00.001] agent.started — ai-agent
  [14:30:00.234] tool.invoked — ai-agent    tool=list_directory
  [14:30:00.257] tool.completed — ai-agent  tool=list_directory, durationMs=23
  [14:30:01.456] tool.invoked — ai-agent    tool=read_file
  ...
  [14:30:12.345] agent.completed — ai-agent iterations=5

══════════════════════════════════════════════════════════
```

---

## How the integration works

The agent loop is simple (~40 lines): ask LLM → execute tool calls → feed results back → repeat. But **every tool goes through the engine first**.

### The governance wrapper

```typescript
// governance.ts — wraps each tool with engine infrastructure

function governTool(tool: Tool, services: EngineServices, runState: RunState): Tool {
  return {
    ...tool,
    async execute(args) {
      // 1. Create a Step in the tracked run
      const step = createToolStep(tool.name, args, runState)

      // 2. Policy check — can this tool run?
      const blocked = await services.policyEvaluator.evaluatePreStep(run, step)
      if (blocked) return "BLOCKED: " + blocked

      // 3. Audit: tool invoked
      await services.auditService.log({ actor, action: "tool.invoked", ... })

      // 4. Execute the actual tool
      const result = await tool.execute(args)

      // 5. Complete step + record metrics + emit events
      completeStep(step, { result, durationMs })
      await services.learner.record({ action: tool.name, success: true, durationMs })
      await services.eventBus.publish(stepCompleted(run.id, step.id))
      await services.auditService.log({ actor, action: "tool.completed", ... })

      return result
    }
  }
}
```

The agent class itself never changes. Tool wrapping is the integration point.

### Policies

Policies are **data-driven rules** evaluated before each tool executes:

```typescript
// Block shell commands entirely
services.policyEvaluator.addRule({
  name: "no_shell",
  effect: PolicyEffect.Deny,          // Hard deny — tool returns "DENIED"
  condition: "action:run_command",
  parameters: {},
})

// Require human approval for file writes
services.policyEvaluator.addRule({
  name: "approve_writes",
  effect: PolicyEffect.RequireApproval, // Blocks and logs
  condition: "action:write_file",
  parameters: {},
})

// Block web access
services.policyEvaluator.addRule({
  name: "no_web",
  effect: PolicyEffect.Deny,
  condition: "action:fetch_url",
  parameters: {},
})
```

Effects: `Allow` (proceed), `RequireApproval` (block + log), `Deny` (hard reject + log).

### What the engine gives the agent

| Engine capability | What it does for the agent |
|---|---|
| **Audit trail** | Immutable log of every tool call — who, what, when, args, result |
| **Policy engine** | Block or gate dangerous tools before they execute |
| **Run tracking** | Full WorkflowRun with Steps — see exactly what happened |
| **Domain events** | Subscribe to `step.started`, `run.completed`, etc. for monitoring |
| **Learner** | Per-tool success rate, avg duration — feedback for optimization |
| **Repositories** | All runs persisted (in-memory default, swap for Postgres) |

---

## The agent core

An AI agent is: **LLM + Tools + Loop**.

```typescript
async run(goal: string): Promise<string> {
  const messages: Message[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: goal },
  ]

  for (let i = 0; i < maxIterations; i++) {
    const response = await llm.chat(messages, tools)

    if (response.toolCalls.length === 0)
      return response.content  // Done — final answer

    for (const call of response.toolCalls) {
      // Each tool.execute() goes through governance (see above)
      const result = await tools.get(call.name).execute(call.arguments)
      messages.push({ role: "tool", toolCallId: call.id, content: result })
    }
  }
}
```

### Tools

| Tool | What it does |
|---|---|
| `fetch_url` | Fetch a URL, strip HTML, return text |
| `read_file` | Read a local file |
| `write_file` | Write to a local file |
| `list_directory` | List directory contents |
| `run_command` | Run a shell command (30s timeout) |
| `think` | Chain-of-thought reasoning scratchpad |

### LLM support

```bash
OPENAI_API_KEY=sk-...          # gpt-4o by default
ANTHROPIC_API_KEY=sk-ant-...   # claude-sonnet-4-20250514 by default
MODEL=gpt-4-turbo              # Override model name
```

Both use raw `fetch` — no SDK deps. The `LLMClient` interface makes adding providers trivial.

---

## The engine substrate

A generic, declarative workflow engine. Used standalone for deterministic workflows, and as the governance/tracking substrate for the AI agent.

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed design docs.

### Engine standalone

The engine also works independently as a workflow execution platform:

```bash
# Dev server
npm run dev -w packages/engine

# Tests (71 tests)
npm test -w packages/engine
```

```bash
# Create a workflow
curl -X POST http://localhost:3000/workflows \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Order Processing",
    "steps": [
      { "id": "validate", "name": "Validate", "action": "http.request",
        "input": { "url": "https://api.example.com/orders/{{input.orderId}}" } },
      { "id": "notify", "name": "Notify", "action": "http.request",
        "input": { "url": "https://api.example.com/notify" },
        "dependsOn": ["validate"] }
    ]
  }'

# Run it
curl -X POST http://localhost:3000/workflows/{id}/runs \
  -d '{ "input": { "orderId": "ORD-123" } }'
```

### API endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `POST` | `/workflows` | Create workflow |
| `GET` | `/workflows` | List workflows |
| `POST` | `/workflows/:id/runs` | Start a run |
| `GET` | `/workflows/:id/runs/:runId` | Get run status |
| `POST` | `/approvals/:id/resolve` | Approve or reject |
| `GET` | `/actions` | List action handlers |

---

## Running the platform

```bash
# Install all deps
npm install

# Start the backend (port 3001)
npm run dev -w packages/server

# Start the UI (port 5179)
npm run dev -w packages/ui
```

Set your LLM key in `.env` at the repo root:

```bash
OPENAI_API_KEY=sk-...
# or
ANTHROPIC_API_KEY=sk-ant-...
```

---

## Messaging Channels (WhatsApp & Messenger)

The server ships with a production-ready message routing layer. When a user sends a message on WhatsApp or Messenger, it triggers an agent run and the reply is delivered back to them automatically, with per-conversation FIFO queuing and exponential-backoff retry.

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

### Management API

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

## Project structure

```
packages/
├── server/                    # Backend API + agent orchestrator
│   └── src/
│       ├── index.ts           # Fastify server, routes, WebSocket
│       ├── orchestrator.ts    # Agent run lifecycle, WebSocket events
│       ├── channels/          # WhatsApp + Messenger routing layer
│       │   ├── types.ts       # ChannelType, InboundMessage, OutboundMessage
│       │   ├── whatsapp.ts    # WhatsApp Cloud API, HMAC-SHA256 validation
│       │   ├── messenger.ts   # Messenger Send API, HMAC-SHA256 validation
│       │   ├── router.ts      # MessageRouter — inbound → agent run → reply
│       │   ├── queue.ts       # Per-conversation FIFO queue with retry
│       │   ├── retry.ts       # Exponential backoff + jitter
│       │   └── store.ts       # SQLite persistence (conversations, queue, configs)
│       └── routes/
│           ├── webhooks.ts    # GET+POST /webhooks/{whatsapp,messenger}, channel API
│           └── ...
│
├── ui/                        # React dashboard
│   └── src/
│       ├── components/
│       │   ├── Logo.tsx       # Robot logo — green eyes online, red offline
│       │   ├── Toolbar.tsx    # Top bar
│       │   ├── PolicyEditor.tsx # Governance modal
│       │   └── ...
│       └── widgets/           # AgentChat, AgentTrace, etc.
│
├── engine/                    # The substrate
│   └── src/
│       ├── domain/            # Models, enums, events, errors, workflow schema
│       ├── ports/             # Interface contracts (repos, event bus, queue)
│       ├── engine/            # Planner, expression resolver, orchestrator, executor, learner
│       ├── governance/        # Policy engine, approval service, audit service
│       ├── actions/           # Built-in action handlers (http, transform, filter)
│       ├── adapters/          # In-memory implementations (swap for Postgres/Redis)
│       ├── api/               # Fastify HTTP layer + DI container
│       └── lib.ts             # Library exports for agent integration
│
└── agent/                     # The AI
    ├── src/
    │   ├── types.ts           # Message, Tool, ToolCall, LLMClient interfaces
    │   ├── agent.ts           # The Agent class — the core loop
    │   ├── governance.ts      # Engine integration — wraps tools with audit/policies
    │   ├── logger.ts          # Colored console output
    │   ├── cli.ts             # CLI entry point (governed + raw modes)
    │   ├── llm/
    │   │   ├── openai.ts      # OpenAI function calling
    │   │   └── anthropic.ts   # Anthropic tool use
    │   └── tools/
    │       ├── fetch-url.ts   # HTTP fetch + HTML stripping
    │       ├── filesystem.ts  # read/write/list with path safety
    │       ├── shell.ts       # Shell command execution
    │       └── think.ts       # Reasoning tool
    └── tests/
        └── governance.test.ts # 18 tests — policies, audit, events, tracking
```

MIT
