# agent001

A monorepo with two TypeScript packages that represent two fundamentally different approaches to automation:

| Package | What it does | How it decides |
|---|---|---|
| **`@agent001/engine`** | Declarative workflow engine — define steps as JSON, the engine executes them in order | You (the human) decide everything up front |
| **`@agent001/agent`** | AI agent with tools — give it a goal, it figures out what to do | The LLM decides at each step |

```
packages/
├── engine/   # Deterministic workflow execution (Fastify API, DAG planner, action handlers)
└── agent/    # LLM-driven agent loop (OpenAI/Anthropic + tools: filesystem, shell, web, think)
```

## Quick start

```bash
# Prerequisites: Node.js >= 20

# Install all dependencies
npm install

# Run engine tests (71 tests)
npm test -w packages/engine

# Run the AI agent (interactive REPL)
OPENAI_API_KEY=sk-... npm start -w packages/agent

# Or with Anthropic
ANTHROPIC_API_KEY=sk-ant-... npm start -w packages/agent

# One-shot mode
OPENAI_API_KEY=sk-... npm start -w packages/agent -- "List all TypeScript files in this repo and summarize what each does"
```

---

## packages/agent — AI Agent

An AI agent is: **LLM + Tools + Loop**. That's it.

```
 ┌──────────────────────────────────────────┐
 │  User: "Find the 3 largest files in src" │
 └──────────────┬───────────────────────────┘
                │
                ▼
 ┌──────────────────────────────┐
 │  LLM (the "brain")          │◄─────────────────────┐
 │  Decides what to do next     │                      │
 └──────────────┬───────────────┘                      │
                │                                      │
       ┌────────┴────────┐                             │
       │ Tool calls?      │                             │
       └────────┬────────┘                             │
          yes   │    no → return final answer          │
                ▼                                      │
 ┌──────────────────────────────┐                      │
 │  Execute tools               │                      │
 │  (read_file, run_command...) │──── results ─────────┘
 └──────────────────────────────┘
```

The loop runs until the LLM produces a response with no tool calls — that's the final answer.

### The core loop (~40 lines)

```typescript
async run(goal: string): Promise<string> {
  const messages: Message[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: goal },
  ]

  for (let i = 0; i < maxIterations; i++) {
    const response = await llm.chat(messages, tools)

    if (response.toolCalls.length === 0)
      return response.content  // Done!

    messages.push({ role: "assistant", content: response.content, toolCalls: response.toolCalls })

    for (const call of response.toolCalls) {
      const result = await tools.get(call.name).execute(call.arguments)
      messages.push({ role: "tool", toolCallId: call.id, content: result })
    }
    // Loop: LLM sees tool results and decides what to do next
  }
}
```

This is the exact same pattern used by ChatGPT, Claude, GitHub Copilot, Cursor, and every other AI agent. The magic isn't in the loop — it's in the LLM's ability to reason and the quality of tool descriptions.

### Tools

| Tool | What it does |
|---|---|
| `fetch_url` | Fetch a URL, strip HTML, return text content |
| `read_file` | Read a local file |
| `write_file` | Write to a local file |
| `list_directory` | List directory contents |
| `run_command` | Run a shell command (30s timeout) |
| `think` | Structured reasoning (chain-of-thought scratchpad) |

### LLM support

Set one environment variable:

```bash
OPENAI_API_KEY=sk-...          # Uses gpt-4o by default
ANTHROPIC_API_KEY=sk-ant-...   # Uses claude-sonnet-4-20250514 by default
MODEL=gpt-4-turbo              # Override model name
```

Both clients use raw `fetch` — no SDK dependencies. The `LLMClient` interface makes it trivial to add more providers.

### Structure

```
packages/agent/src/
├── types.ts           # Message, Tool, ToolCall, LLMClient interfaces
├── agent.ts           # The Agent class — the core loop
├── logger.ts          # Colored console output
├── cli.ts             # CLI entry point (REPL + one-shot)
├── llm/
│   ├── openai.ts      # OpenAI chat completions (function calling)
│   └── anthropic.ts   # Anthropic messages API (tool use)
└── tools/
    ├── fetch-url.ts   # HTTP fetch + HTML stripping
    ├── filesystem.ts  # read/write/list with path safety
    ├── shell.ts       # Shell command execution
    └── think.ts       # Passthrough reasoning tool
```

---

## packages/engine — Workflow Engine

A generic, declarative workflow engine. Business users define outcomes as JSON workflow definitions. The engine plans execution order (DAG), resolves `{{expressions}}`, enforces policies, and dispatches to pluggable action handlers.

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed design docs.

### Engine architecture

```
┌─────────────────────────────────────────────────────────────┐
│  API Layer  (Fastify)                                       │
│  /workflows  /runs  /approvals  /actions  /health           │
├─────────────────────────────────────────────────────────────┤
│  Engine (generic — interprets any WorkflowDefinition)       │
│  ┌──────────┐ ┌───────────┐ ┌────────────┐ ┌──────────┐    │
│  │ Planner  │→│ Expression│→│Orchestrator│→│ Learner  │    │
│  │(topo-sort│ │  Engine   │ │ (generic   │ │(stats /  │    │
│  │  DAG)    │ │ {{...}}   │ │  loop)     │ │ feedback)│    │
│  └──────────┘ └───────────┘ └────────────┘ └──────────┘    │
├─────────────────────────────────────────────────────────────┤
│  Action Handlers  (pluggable — register any at runtime)     │
│  http.request · transform · filter · noop · log · yours     │
├─────────────────────────────────────────────────────────────┤
│  Governance  (policies · approvals · audit)                 │
├─────────────────────────────────────────────────────────────┤
│  Ports & Adapters  (repos · event bus · work queue)         │
└─────────────────────────────────────────────────────────────┘
```

### Engine quick start

```bash
# Dev server (auto-reload)
npm run dev -w packages/engine

# Run tests (71 tests)
npm test -w packages/engine

# Build for production
npm run build -w packages/engine
```

### Define a workflow

```bash
curl -X POST http://localhost:3000/workflows \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Order Processing",
    "steps": [
      {
        "id": "validate",
        "name": "Validate Order",
        "action": "http.request",
        "input": { "url": "https://api.example.com/orders/{{input.orderId}}", "method": "GET" }
      },
      {
        "id": "notify",
        "name": "Send Confirmation",
        "action": "http.request",
        "input": { "url": "https://api.example.com/notify", "method": "POST" },
        "dependsOn": ["validate"]
      }
    ]
  }'
```

### Run it

```bash
curl -X POST http://localhost:3000/workflows/{id}/runs \
  -H "Content-Type: application/json" \
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

## Agent vs Engine — when to use which

| | Agent | Engine |
|---|---|---|
| **Decision maker** | LLM (non-deterministic) | You (deterministic) |
| **Good for** | Open-ended goals, research, code tasks | Repeatable business processes |
| **Steps** | Decided at runtime by the LLM | Defined up front as JSON |
| **Predictability** | Low — may take different paths each time | High — same input = same execution |
| **Cost** | LLM API calls per iteration | Zero LLM cost |
| **Example** | "Research competitors and write a report" | "Validate order → check inventory → notify" |

MIT
