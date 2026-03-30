# Architecture & Design — The Complete Technical Guide

> **Purpose**: This document explains every file, how the pieces connect, what happens at runtime, and why the architecture is designed this way. Written for learning — not just _what_, but _why_.

---

## Table of Contents

1. [What This Platform Is](#what-this-platform-is)
2. [Project Structure — The 10,000-Foot View](#project-structure)
3. [User Perspective — What Happens When You Use It](#user-perspective)
4. [The Agent Package](#the-agent-package)
   - [Core Files](#agent-core-files)
   - [Engine Subdirectory (Governance Infrastructure)](#engine-subdirectory)
   - [LLM Clients](#llm-clients)
   - [Built-in Tools](#built-in-tools)
5. [The Server Package](#the-server-package)
   - [Core Server Files](#server-core-files)
   - [Channels (Multi-Platform Messaging)](#channels)
   - [LLM Registry](#llm-registry)
   - [REST API Routes](#rest-api-routes)
6. [The UI Package](#the-ui-package)
   - [Core UI Files](#ui-core-files)
   - [Components](#ui-components)
   - [Widgets](#ui-widgets)
7. [How Everything Connects](#integration-boundary)
8. [Complete Execution Flow](#execution-flow)
9. [Design Patterns & Architectural Decisions](#design-patterns)
10. [Resilience, Notifications & Approval Workflow](#resilience)
    - [Tool Retry with Exponential Backoff](#tool-retry)
    - [Tool Timeouts](#tool-timeouts)
    - [Idempotent Resume](#idempotent-resume)
    - [Auto-Recovery on Startup](#auto-recovery)
    - [Approval Workflow](#approval-workflow)
    - [Notification System](#notification-system)
    - [Modal Widget Viewer](#modal-widget-viewer)
11. [Why This Architecture Makes Swapping Easy](#swapping)
12. [Testing Strategy](#testing-strategy)
13. [Dependency Flow](#dependency-flow)

---

## What This Platform Is

agent001 is three things in one:

1. **An AI agent** (`packages/agent`) — an LLM (GPT-4o, Claude, GitHub Copilot, etc.) with tools (filesystem, shell, web fetch) running in a Think → Act → Observe loop, wrapped by a governance engine that provides policy checks, audit trails, run tracking, domain events, and execution metrics.
2. **A command-center server** (`packages/server`) — a Fastify backend with SQLite persistence, agent orchestration (start/cancel/resume runs), multi-platform messaging (WhatsApp, Messenger), real-time WebSocket updates, and a comprehensive REST API.
3. **A real-time dashboard** (`packages/ui`) — a React 19 + Tailwind CSS web UI with 9 draggable widgets (chat, trace, graph visualization, run history, step timeline, tool stats, audit trail, live logs, run status), notifications, and a mobile-responsive layout.

The key insight: **the agent runs _on_ a governance engine embedded within it.** Every time the LLM calls a tool, that call passes through the governance layer before the tool actually runs. This gives you:

- An **immutable audit trail** of every action the AI took
- **Policy enforcement** — block or require approval for dangerous operations
- **Run tracking** — the entire agent session as a first-class AgentRun with Steps
- **Domain events** — every state change emits an event for monitoring/WebSocket
- **Execution metrics** — timing, success rates, failure counts per tool
- **Tool retry + timeouts** — exponential backoff on transient failures, 60s timeout

```
┌─────────────────────────────────────────────────────────────┐
│                  USER (Web Dashboard or CLI)                 │
│  "Summarize the README and list all TypeScript files"        │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│              packages/server (Fastify + SQLite)               │
│   orchestrator.ts  →  routes/*  →  db.ts  →  ws.ts          │
│   Start/cancel/resume runs, persist, broadcast events        │
└──────────────────────────┬──────────────────────────────────┘
                           │ imports @agent001/agent
┌──────────────────────────▼──────────────────────────────────┐
│                   packages/agent                             │
│                                                              │
│   governance.ts ──→ agent.ts (LLM + Loop)                   │
│        │                │                                    │
│   wraps tools        Think → Act → Observe                   │
│   with engine                                                │
│        │                                                     │
│   ┌────▼──────────────────────────────────────────────┐     │
│   │    Tool calls (governed with retry + timeout)      │     │
│   │  ┌──────────┐ ┌──────────┐ ┌──────────┐          │     │
│   │  │read_file │ │run_command│ │fetch_url │  ...     │     │
│   │  └────┬─────┘ └────┬─────┘ └────┬─────┘          │     │
│   └───────┼─────────────┼─────────────┼───────────────┘     │
│           │             │             │                       │
│   ┌───────▼─────────────▼─────────────▼───────────────┐     │
│   │  engine/ (governance substrate — embedded)         │     │
│   │  Policy check → Audit log → Execute → Record       │     │
│   │  PolicyEvaluator · AuditService · Learner          │     │
│   │  EventBus · RunRepository (in-memory adapters)     │     │
│   └────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────┘
                           ▲
┌──────────────────────────┴──────────────────────────────────┐
│                   packages/ui (React 19 + Vite)              │
│   9 widgets · notifications · graph viz · grid layout        │
│   WebSocket subscription · Zustand state · Tailwind CSS      │
└──────────────────────────────────────────────────────────────┘
```

---

<a id="project-structure"></a>
## Project Structure — The 10,000-Foot View

```
agent001/                          ← npm workspaces monorepo root
├── package.json                   ← workspaces: ["packages/*"], shared scripts (dev, test, build, lint)
├── ARCHITECTURE.md                ← this file
├── README.md                      ← quickstart, usage examples
├── docs/
│   └── NETWORK_ACCESS.md         ← guide for accessing server from other devices
├── .env                           ← API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
│
├── packages/agent/                ← THE AGENT — LLM + tools + governance engine (embedded)
│   ├── package.json               ← @agent001/agent, zero runtime deps, exports: { ".": "./src/lib.ts" }
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── src/
│   │   ├── types.ts               ← core vocabulary: Message, Tool, LLMClient, ToolCall, AgentConfig
│   │   ├── agent.ts               ← THE agent loop (~40 lines of core logic)
│   │   ├── governance.ts          ← THE integration layer — wraps tools with engine services
│   │   ├── retry.ts               ← tool retry with exponential backoff + jitter
│   │   ├── cli.ts                 ← standalone entry point — governed/raw modes, REPL + one-shot
│   │   ├── logger.ts              ← colored console output for CLI mode
│   │   ├── lib.ts                 ← barrel export — public API for @agent001/agent
│   │   ├── engine/                ← governance infrastructure (10 files, flat)
│   │   │   ├── index.ts           ← barrel re-export for engine/
│   │   │   ├── models.ts          ← AgentRun, Step, PolicyRule, AuditEntry — state machines
│   │   │   ├── enums.ts           ← RunStatus, StepStatus, PolicyEffect
│   │   │   ├── events.ts          ← domain events (RunStarted, StepCompleted, ApprovalRequired, etc.)
│   │   │   ├── errors.ts          ← DomainError, InvalidTransitionError, PolicyViolationError
│   │   │   ├── interfaces.ts      ← port interfaces (RunRepository, AuditRepository, EventBus, etc.)
│   │   │   ├── memory.ts          ← in-memory adapters (MemoryRunRepository, MemoryEventBus, etc.)
│   │   │   ├── policy.ts          ← RulePolicyEvaluator — data-driven governance rules
│   │   │   ├── audit.ts           ← AuditService — immutable audit trail
│   │   │   └── learner.ts         ← Learner — execution stats aggregator
│   │   ├── llm/
│   │   │   ├── openai.ts          ← OpenAI Chat Completions client (raw fetch, no SDK)
│   │   │   └── anthropic.ts       ← Anthropic Messages API client (raw fetch, no SDK)
│   │   └── tools/
│   │       ├── filesystem.ts      ← read_file, write_file, list_directory (sandboxed with path escape prevention)
│   │       ├── shell.ts           ← run_command (30s timeout, command blocklist)
│   │       ├── fetch-url.ts       ← fetch_url (HTML stripping, SSRF blocker, 15s timeout)
│   │       └── think.ts           ← think (chain-of-thought passthrough)
│   └── tests/
│       ├── governance.test.ts     ← 18 tests (mock LLM, no API keys needed)
│       └── retry.test.ts          ← 13 tests (exponential backoff, retryable error detection)
│
├── packages/server/               ← THE SERVER — persistence, orchestration, messaging, REST API
│   ├── package.json               ← @agent001/server, depends on @agent001/agent + fastify + better-sqlite3
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── src/
│   │   ├── index.ts               ← server startup — Fastify factory, route registration, migrations
│   │   ├── orchestrator.ts        ← AgentOrchestrator — manages run lifecycle (start, track, resume, cancel, recover)
│   │   ├── db.ts                  ← SQLite persistence (~9 tables: runs, audit, checkpoints, logs, layouts, policies, usage, notifications, channels)
│   │   ├── tools.ts               ← tool registry — resolves tool names to agent tool implementations
│   │   ├── ws.ts                  ← WebSocket broadcast — real-time event distribution to UI
│   │   ├── channels/              ← multi-platform messaging (8 files)
│   │   │   ├── index.ts           ← barrel export
│   │   │   ├── types.ts           ← Channel, ChannelConfig, InboundMessage, OutboundMessage
│   │   │   ├── whatsapp.ts        ← WhatsApp Business Cloud API integration
│   │   │   ├── messenger.ts       ← Facebook Messenger Platform integration
│   │   │   ├── queue.ts           ← MessageQueue — FIFO, per-user serialization
│   │   │   ├── retry.ts           ← ChannelApiError, withRetry — exponential backoff for API calls
│   │   │   ├── router.ts          ← MessageRouter — inbound → agent run, run → outbound queue
│   │   │   └── store.ts           ← SqliteConversationStore, SqliteQueueStore
│   │   ├── llm/                   ← LLM provider management
│   │   │   ├── copilot.ts         ← CopilotClient — GitHub Models API (OpenAI-compatible)
│   │   │   └── registry.ts        ← buildLlmClient() factory, PROVIDER_DEFAULTS for 4 providers
│   │   └── routes/                ← REST API endpoints (8 files)
│   │       ├── runs.ts            ← GET/POST /api/runs — start, list, resume, cancel, trace
│   │       ├── agents.ts          ← GET/POST/PUT/DELETE /api/agents, GET /api/tools
│   │       ├── layouts.ts         ← GET/PUT /api/dashboard-state, CRUD /api/layouts
│   │       ├── policies.ts        ← GET/POST/DELETE /api/policies
│   │       ├── notifications.ts   ← GET/POST /api/notifications — list, mark-read, execute actions
│   │       ├── llm.ts             ← GET/PUT /api/llm — provider config + hot-swap
│   │       ├── usage.ts           ← GET /api/usage — token consumption tracking
│   │       └── webhooks.ts        ← GET/POST /webhooks/whatsapp, /webhooks/messenger, /api/channels
│   └── tests/
│       ├── channels.test.ts       ← 30 tests (retry, queue, webhook parsing, HMAC, routing)
│       └── notifications.test.ts  ← 10 tests (CRUD, unread counts, stale-run detection)
│
└── packages/ui/                   ← THE DASHBOARD — React 19 + Tailwind CSS + Zustand
    ├── package.json               ← @agent001/ui, react@19, zustand@5, react-grid-layout, react-force-graph-2d
    ├── tsconfig.json
    ├── vite.config.ts             ← Vite 6 + React plugin + Tailwind CSS v4
    ├── index.html
    └── src/
        ├── main.tsx               ← React entry point
        ├── App.tsx                ← root component — toolbar, canvas, modals
        ├── api.ts                 ← HTTP client + WebSocket subscription to server
        ├── store.ts               ← Zustand store — views, runs, widgets, logs, audit, notifications
        ├── types.ts               ← Run, Step, AuditEntry, TraceEntry, WidgetType, Notification
        ├── util.ts                ← randomId, timeAgo, truncate, formatMs, statusColor
        ├── dashboardSync.ts       ← auto-save views to server (2s debounce), restore on startup
        ├── index.css              ← global Tailwind styles + CSS theme variables
        ├── hooks/
        │   └── useIsMobile.ts     ← responsive hook (width < 768px)
        ├── components/            ← reusable UI (12 files)
        │   ├── Canvas.tsx         ← grid layout container (react-grid-layout), drag/resize
        │   ├── Toolbar.tsx        ← top bar — logo, tabs, notification bell, menu dropdown
        │   ├── ViewTabs.tsx       ← tab bar for multiple dashboard views
        │   ├── WidgetCatalog.tsx  ← modal for adding widgets (9 types)
        │   ├── WidgetFrame.tsx    ← chrome around each widget (drag handle, pop-out, close)
        │   ├── WidgetModal.tsx    ← pop-out widget viewer as floating modal
        │   ├── NotificationPanel.tsx ← bell icon + dropdown with notification list
        │   ├── Logo.tsx           ← SVG brand mark with online/offline glow
        │   ├── AgentEditor.tsx    ← agent CRUD (list/create/edit/delete, tool picker, prompt editor)
        │   ├── PolicyEditor.tsx   ← governance dashboard (tools, permissions, blocklists)
        │   ├── UsageModal.tsx     ← token stats (cumulative + per-run breakdown)
        │   └── MobileNav.tsx      ← bottom nav for mobile (widget switcher with icons)
        └── widgets/               ← agent visualization & interaction (10 files)
            ├── index.ts           ← widget registry — maps WidgetType → React component
            ├── AgentChat.tsx      ← send goals to agent (voice input, agent picker, auto-scroll)
            ├── AgentTrace.tsx     ← rich execution trace (ReAct loop visualization)
            ├── AgentViz.tsx       ← force-directed graph (react-force-graph-2d, draggable nodes, particles)
            ├── RunStatus.tsx      ← current run metadata (status badge, timing, step counts, actions)
            ├── RunHistory.tsx     ← list of past runs (click to select, inline cancel/resume)
            ├── StepTimeline.tsx   ← vertical timeline of steps (status icons, duration, retry badge)
            ├── ToolStats.tsx      ← performance metrics per tool (call count, avg duration, failure rate)
            ├── AuditTrail.tsx     ← immutable audit log (filterable by action/actor, expandable)
            └── LiveLogs.tsx       ← event stream (filter by level, auto-scroll)
```

**Why three packages?** Separation of concerns:
- **agent** — pure TypeScript, zero runtime dependencies. The LLM loop + governance engine + tools. Can run standalone via CLI or be imported as a library.
- **server** — adds persistence (SQLite), orchestration (manages multiple concurrent runs), messaging (WhatsApp/Messenger), and a REST API + WebSocket layer. Imports `@agent001/agent`.
- **ui** — the visual interface. Connects to the server via HTTP + WebSocket. No direct dependency on the agent package.

---

<a id="user-perspective"></a>
## User Perspective — What Happens When You Use It

### Starting the Platform (Primary — Web Dashboard)

```bash
# Start both server + UI in parallel:
npm run dev
# → Server on http://localhost:3001
# → UI on http://localhost:5179
```

Open the browser. You see a dashboard with draggable widgets — chat, trace, graph visualization, run history, step timeline, tool stats, audit trail, live logs. Type a goal into the Agent Chat widget. The server starts an agent run, and results stream in real-time via WebSocket.

### What You See (Web Dashboard)

- **Agent Chat**: Type a goal → agent runs → streaming trace appears
- **Agent Trace**: Each iteration of the Think → Act → Observe loop, expandable tool calls
- **Agent Viz**: Force-directed graph of the run structure — nodes for goals, tools, results
- **Run History**: All past runs, click to select, inline cancel/resume buttons
- **Step Timeline**: Vertical timeline — status icons, duration, retry badges
- **Tool Stats**: Bar chart of tool performance (count, avg duration, failure rate)
- **Audit Trail**: Immutable log table, filterable by action/actor
- **Live Logs**: Real-time event stream with level filtering
- **Run Status**: Current run metadata — status badge, goal, timing, step counts
- **Notification Bell**: Top-right corner — alerts for run completion, failures, approvals

### Starting the Agent (Standalone CLI)

```bash
# Governed mode (default) — full audit + policies + tracking
ANTHROPIC_API_KEY=sk-ant-... npm start -w packages/agent

# One-shot mode (non-interactive)
npm start -w packages/agent -- "Summarize the README"

# Raw mode — bare agent loop, no governance
AGENT_MODE=raw OPENAI_API_KEY=sk-... npm start -w packages/agent
```

### What You See (CLI — Governed Mode)

```
🧠 Using Anthropic (claude-sonnet-4-20250514)
🔧 Tools: fetch_url, read_file, write_file, list_directory, run_command, think
🛡️  Governed mode — audit trail + policies + run tracking

🎯 > What files are in this project?

🔄 Iteration 0/30
💭 Let me look at the project structure...
🔧 Tool call: list_directory({})
📋 Result: src/ package.json tsconfig.json ...
🔄 Iteration 1/30
💭 I can see the structure. Let me provide the answer.
✅ Final answer: This project contains...

═══════════════════════════════════════════════════
  Governance Report
═══════════════════════════════════════════════════
  Run ID:    a1b2c3d4-...
  Status:    Completed
  Steps:     1 total
───────────────────────────────────────────────────
  Audit Trail:
    agent.started   → goal: "What files are in this project?"
    tool.invoked    → list_directory
    tool.completed  → list_directory (12ms)
    agent.completed → 1 iterations, 142 chars
───────────────────────────────────────────────────
  Tool Stats:
    list_directory  → 1 call, avg 12ms, 0 failures
═══════════════════════════════════════════════════
```

### What Happens Under the Hood (Web Dashboard Flow)

1. User types goal in Agent Chat widget
2. UI calls `POST /api/runs` with `{ goal, agentId? }`
3. Server's `orchestrator.startRun()` creates run in SQLite, broadcasts `run.queued` via WebSocket
4. Orchestrator creates engine services, wraps tools with governance, starts agent in background
5. Each tool call: governance intercepts → policy check → audit → retry/timeout → execute → record
6. Trace events, step updates, and logs stream to UI via WebSocket
7. On completion: run saved, notification created, `run.completed` broadcast
8. UI updates RunHistory, StepTimeline, AuditTrail, ToolStats — all in real-time

---

<a id="the-agent-package"></a>
## The Agent Package

The agent package (`packages/agent`) is the core: the LLM loop, tools, and embedded governance engine. It has **zero runtime dependencies** — pure TypeScript.

<a id="agent-core-files"></a>
### Core Files

### `src/types.ts` — The Core Vocabulary

This file defines the 6 interfaces that every agent component speaks. It has zero logic — just shapes:

| Interface | Purpose | Used By |
|-----------|---------|---------|
| `Message` | A chat turn: `{ role, content, toolCalls?, toolCallId? }` | Agent loop, LLM clients |
| `ToolCall` | LLM's request to invoke a tool: `{ id, name, arguments }` | LLM response → tool dispatch |
| `Tool` | A capability: `{ name, description, parameters, execute() }` | Tool implementations, registry |
| `LLMClient` | The "brain": `chat(messages, tools) → LLMResponse` | Agent calls this each iteration |
| `LLMResponse` | What the LLM returns: `{ content?, toolCalls }` | Agent decides: text = done, tools = act |
| `AgentConfig` | Knobs: `{ maxIterations?, systemPrompt?, verbose? }` | Agent constructor |

**Design decision**: `Tool.execute()` returns `Promise<string>`, not structured data. Why? LLMs consume text. Every tool result goes back into the message history as a string. Structured output would just get serialized anyway.

**Design decision**: `LLMClient` is an interface, not tied to a provider. The agent doesn't know if it's talking to OpenAI or Anthropic. This is the **Strategy pattern** — swap the brain without touching the loop.

### `src/agent.ts` — THE Agent (40 Lines of Core Logic)

The entire agentic AI pattern in one loop:

```
1. Receive goal → build message history [system prompt, user goal]
2. Loop (max 30 iterations):
   a. Call llm.chat(messages, tools) → get LLMResponse
   b. If no tool calls → return content as final answer (DONE)
   c. For each tool call:
      - Find tool by name in Map
      - Call tool.execute(args)
      - Push result as tool message into history
   d. Go to step 2 (LLM sees results and decides next action)
3. If max iterations reached → return timeout message
```

**Why this is the same pattern as ChatGPT, Cursor, Devin**: The agent's power doesn't come from the loop (it's trivial). It comes from:
- The LLM's reasoning ability (which tool to call, in what order)
- The quality of tool descriptions (tells the LLM _when_ to use each tool)
- The system prompt (sets behavioral guidelines)
- The accumulated message history (the agent "remembers" every result)

**Key implementation details**:
- Tools stored in a `Map<string, Tool>` for O(1) lookup by name
- Unknown tool calls produce an error message _in the conversation_ (not a throw) — the LLM can recover
- Tool execution errors are also caught and added as messages — the LLM learns from failures
- `AgentConfig.verbose` controls whether `logger.ts` functions are called

### `src/cli.ts` — The Entry Point

Two modes, controlled by `AGENT_MODE` env var:

| Mode | Env | What It Does |
|------|-----|-------------|
| `governed` (default) | `AGENT_MODE=governed` or unset | Creates engine services → wraps tools → runs agent → prints governance report |
| `raw` | `AGENT_MODE=raw` | Creates bare Agent → runs directly → no audit, no policies |

Both modes support:
- **One-shot**: Pass goal as CLI argument → run once → exit
- **REPL**: No argument → interactive prompt loop → `exit` to quit

**Key functions in this file**:
- `createLLMClient()` — reads `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, picks provider, respects `MODEL` env var for override. Auto-detection order: Anthropic first, then OpenAI.
- `allTools()` — returns the array of 6 tools (fetch, read, write, list, shell, think)
- `setupDefaultPolicies()` — hook with commented-out examples showing how to add rules
- `main()` — the actual entrypoint: create client → check mode → run/repl

### `src/logger.ts` — Pretty Console Output

Eight functions, each for a specific agent activity:

| Function | Output | When Called |
|----------|--------|-------------|
| `logGoal(goal)` | 🎯 Goal: ... | Start of agent.run() |
| `logIteration(i, max)` | 🔄 Iteration 3/30 | Each loop iteration |
| `logThinking(content)` | 💭 ... | LLM returned text alongside tool calls |
| `logToolCall(name, args)` | 🔧 Tool call: name({...}) | Before executing a tool |
| `logToolResult(result)` | 📋 Result: ... | After successful tool execution |
| `logToolError(error)` | ❌ Error: ... | Tool execution failed |
| `logFinalAnswer(answer)` | ✅ Final answer: ... | Agent loop complete |
| `logError(msg)` | 💥 ... | Fatal/max-iteration errors |

Uses ANSI color codes (CYAN, GREEN, YELLOW, RED, MAGENTA, DIM, BOLD). Truncates long results to keep output readable.

### `src/llm/openai.ts` — OpenAI Client

Implements `LLMClient` using raw `fetch()` — no SDK dependency.

**Request flow**: Messages + Tools → OpenAI format → POST `/v1/chat/completions` → parse response.

**Key transformations**:
- `Tool[]` → `{ type: "function", function: { name, description, parameters } }[]` (OpenAI's function calling schema)
- `Message[]` → OpenAI message format (tool results use `role: "tool"`)
- Response `tool_calls[]` → `ToolCall[]` (id, name, parsed JSON arguments)

**Configurable**: `baseUrl` defaults to `https://api.openai.com` but can be overridden for Azure OpenAI, vLLM, Ollama, or any OpenAI-compatible API.

### `src/llm/anthropic.ts` — Anthropic Client

Same `LLMClient` interface, completely different wire protocol:

**Key differences from OpenAI**:
- System prompt is a top-level `system` parameter, not a message
- Content is an array of blocks (`[{ type: "text", text: "..." }, { type: "tool_use", ... }]`)
- Tool results are sent as `user` messages with `tool_result` content blocks
- Consecutive tool results must be merged into a single user message (Anthropic rejects otherwise)
- Response parsing: content blocks → extract `text` for content, `tool_use` for tool calls

**Why raw fetch instead of SDKs?** Zero dependencies. The OpenAI and Anthropic SDKs are heavy. We need exactly one endpoint from each. Raw fetch keeps the agent package dependency-free (except the engine workspace link).

### `src/tools/filesystem.ts` — File I/O (Sandboxed)

Three tools + a safety function:

| Tool | What It Does |
|------|-------------|
| `read_file` | `readFile(path, 'utf-8')` → returns file contents as string |
| `write_file` | `writeFile(path, content)` → creates/overwrites file |
| `list_directory` | `readdir(path)` → returns formatted list with file/dir indicators |

**`safePath(requestedPath)`** — the security boundary:
- Resolves the path against a base directory (defaults to `process.cwd()`)
- Checks that the resolved path is _inside_ the base directory
- Prevents `../../etc/passwd` style escapes
- `setBasePath()` lets you change the base directory

**Design decision**: Tools return error strings instead of throwing. Why? If `read_file` throws, the agent crashes. If it returns `"Error: ENOENT..."`, the LLM sees the error and can try a different path. Resilience through error-as-data.

### `src/tools/shell.ts` — Shell Execution

Runs commands via `child_process.execFile('/bin/sh', ['-c', command])`:
- 30-second timeout (kills process if exceeded)
- 1MB max buffer
- Returns `stdout + stderr` combined
- Caught errors return the error message as a string

### `src/tools/think.ts` — Chain of Thought

The simplest tool — returns its input unchanged:

```typescript
execute: async (args) => args.thought as string
```

**Why does this exist?** It forces the LLM to separate reasoning from action. When the LLM calls `think("I should check the package.json first because...")`, that thought gets recorded in the message history. This leads to better decisions on the _next_ iteration because the LLM can reference its own reasoning. Anthropic and OpenAI both recommend this pattern.

### `src/governance.ts` — THE Integration Layer

**This is the most important file in the agent package.** It's where the agent loop meets the governance engine. ~330 lines that turn a bare agent into a governed agent.

#### What It Does

1. **Creates engine infrastructure** (`createEngineServices()`):
   - In-memory repositories for runs, audit, execution records
   - Event bus, policy evaluator, learner

2. **Wraps each tool** (`governTool(tool, services, state, options?) → Tool`):
   The returned tool has the same interface but every `execute()` now goes through:
   ```
   Policy check (can this tool run?)
     ↓ denied → audit "tool.denied" → return "DENIED: ..."
     ↓ needs approval → emit ApprovalRequired event → return "BLOCKED: ..."
     ↓ allowed → continue
   Start step + emit stepStarted event
   Audit "tool.invoked"
   Timeout wrapper (60s default via Promise.race)
   Retry wrapper (2 retries, exponential backoff, only transient errors)
   Execute the actual tool (original tool.execute())
   Complete step + emit stepCompleted event
   Record execution metric (to Learner, includes attempt count)
   Audit "tool.completed"
   Save run to repository
   Return result to agent
   ```

3. **Runs the governed agent** (`runGoverned(goal, llm, tools, services)`):
   - Creates an `AgentRun` (the agent session becomes a tracked run)
   - Wraps all tools with `governTool()`
   - Creates a standard `Agent` with the wrapped tools (the agent doesn't know it's governed)
   - Runs the agent
   - Collects results: run, audit trail, per-tool stats
   - Returns a `GovernedResult`

4. **Prints the report** (`printGovernanceReport(result)`):
   - Run ID, status, step count
   - Full audit trail with timestamps
   - Per-tool statistics (calls, avg duration, failures)

#### The Key Insight — The Decorator Pattern

`governTool()` is the **Decorator pattern**. It takes a `Tool` and returns a `Tool` with the same interface but added behavior. The agent doesn't know its tools are wrapped. It calls `tool.execute()` the same way it always would. The governance is invisible to the agent loop.

This is why the integration is clean: **no changes to `agent.ts` were needed.** The agent loop is exactly the same whether tools are governed or raw. The wrapping happens _outside_ the agent, in the composition layer.

#### Shared State via `RunState`

The `governTool()` wrapper captures a mutable `RunState` object via closure:
```typescript
interface RunState {
  run: AgentRun       // the current run (steps get pushed onto this)
  actor: string       // who's running the agent
  stepCounter: number // monotonically increasing step counter
}
```

All wrapped tools share the same `RunState`. When tool A executes and adds a step, tool B (called later) sees it because they share the same `run` object. This is how the governance layer builds up a complete picture of the agent's session.

### `src/retry.ts` — Tool Retry with Exponential Backoff

Provides `withToolRetry()` — wraps any tool execution with retry logic for transient errors.

**Key exports**:
- `ToolRetryPolicy` — configurable: maxRetries, baseDelayMs, maxDelayMs, backoffMultiplier, jitterFactor
- `TOOL_RETRY_POLICY` — defaults: 2 retries, 500ms base, 5s max, 2x multiplier, 0.3 jitter
- `withToolRetry(fn, policy)` → `{ success, value?, attempts, lastError? }`
- `isRetryableError(err)` — heuristic: retries on timeout, network, rate-limit errors only
- `computeDelay(attempt, policy)` — exponential with jitter

Non-transient errors (validation, permission, logic) fail immediately with no retry.

### `src/lib.ts` — Barrel Export

The public API for `@agent001/agent`. This is what the server package imports. Re-exports everything consumers need:

- **Core**: `Agent`, `Message`, `Tool`, `LLMClient`, `ToolCall`, `AgentConfig`
- **Governance**: `createEngineServices()`, `governTool()`, `runGoverned()`, `printGovernanceReport()`, `GovernToolOptions`, `GovernedResult`
- **Engine**: all models, enums, events, errors, interfaces, services, adapters
- **Retry**: `withToolRetry()`, `ToolRetryPolicy`, `isRetryableError()`
- **LLM clients**: `AnthropicClient`, `OpenAIClient`
- **Tools**: `fetchUrlTool`, `readFileTool`, `writeFileTool`, `listDirectoryTool`, `shellTool`, `thinkTool`, `setBasePath`, `setShellCwd`

---

<a id="engine-subdirectory"></a>
## The Engine Subdirectory — `packages/agent/src/engine/`

The governance engine is not a separate package — it's embedded within the agent package as a flat subdirectory with 10 files. This keeps the agent self-contained (zero runtime dependencies) while providing full governance infrastructure.

The engine follows a simplified hexagonal pattern: **interfaces** define ports, **memory adapters** implement them, and **services** (audit, policy, learner) depend only on interfaces.

### `engine/models.ts` — Domain Entities & State Machines

The core business objects with guarded state transitions:

**`AgentRun`** — a single agent execution session
- States: `Pending → Planning → Running → Completed | Failed | Cancelled`
- Also: `Running → WaitingForApproval → Running` (for policy pauses)
- Factory: `createRun(workflowId, input)`
- Transitions: `startPlanning()`, `startRunning(steps)`, `completeRun()`, `failRun()`
- Holds: `steps: Step[]`, `input`, timestamps

**`Step`** — a single tool call within a run
- States: `Pending → Running → Completed | Failed`
- Also: `Pending → Skipped | Blocked`, `Failed → Running` (retry), `Running → Blocked | Skipped`
- Transitions: `startStep()`, `completeStep(output)`, `failStep(error)`
- Holds: `action`, `input`, `output`, `error`, `order`, timestamps

**`PolicyRule`** — a governance rule definition
- Shape: `{ name, effect, condition, parameters }`
- Used by `RulePolicyEvaluator` to check steps before execution

**`AuditEntry`** — an immutable log record
- Factory: `createAuditEntry({ actor, action, resourceType, resourceId, detail })`

**`ExecutionRecord`** — a performance metric
- Fields: `runId, stepId, action, success, durationMs, result, error`
- Used by `Learner` for stats aggregation

**State machine guards**: `STEP_TRANSITIONS` and `RUN_TRANSITIONS` are `Map<Status, Set<Status>>` objects. Every transition function checks the map before mutating. Illegal transitions throw `InvalidTransitionError`.

### `engine/enums.ts` — Status Types

Three enums:

| Enum | Values |
|------|--------|
| `RunStatus` | Pending, Planning, Running, WaitingForApproval, Completed, Failed, Cancelled |
| `StepStatus` | Pending, Running, Completed, Failed, Skipped, Blocked |
| `PolicyEffect` | Allow, RequireApproval, Deny |

### `engine/events.ts` — Domain Events

Immutable event objects emitted at state transitions. All extend `DomainEvent` (base: `eventId`, `type`, `occurredAt`):

| Event | Emitted When | Extra Fields |
|-------|-------------|--------------|
| `RunStarted` | Run begins | runId, workflowId |
| `RunCompleted` | Run finishes successfully | runId |
| `RunFailed` | Run fails | runId, reason |
| `StepStarted` | Step begins | runId, stepId |
| `StepCompleted` | Step finishes successfully | runId, stepId |
| `StepFailed` | Step fails | runId, stepId, reason |
| `ApprovalRequired` | Policy requires approval | runId, stepId, toolName, args, reason |

Each has a factory function (e.g., `runStarted(runId, workflowId)`) that generates a UUID and timestamp.

### `engine/errors.ts` — Domain Error Hierarchy

| Error | When Thrown |
|-------|-----------|
| `DomainError` | Base class (extends `Error`) |
| `InvalidTransitionError` | Illegal state machine transition (e.g., Pending → Completed directly) |
| `PolicyViolationError` | Policy with `Deny` effect matched a tool call |

### `engine/interfaces.ts` — Port Interfaces (Contracts)

Three repository interfaces + two service interfaces:

| Interface | Methods | Purpose |
|-----------|---------|---------|
| `RunRepository` | `save(run)`, `get(runId)` | Store/retrieve AgentRun entities |
| `AuditRepository` | `append(entry)`, `listByResource(type, id)` | Append-only audit log storage |
| `ExecutionRecordRepository` | `append(record)`, `listByAction(action)` | Performance metric storage |
| `PolicyEvaluator` | `evaluatePreStep(run, step)` | Check step before execution: null = allow, string = needs approval, throw = deny |
| `EventBus` | `publish(event)`, `subscribe(type, handler)` | Publish/subscribe domain events |

### `engine/memory.ts` — In-Memory Adapters

Four adapter classes implementing the port interfaces:

| Class | Port | Storage |
|-------|------|---------|
| `MemoryRunRepository` | `RunRepository` | `Map<id, AgentRun>` |
| `MemoryAuditRepository` | `AuditRepository` | `AuditEntry[]` |
| `MemoryExecutionRecordRepository` | `ExecutionRecordRepository` | `ExecutionRecord[]` |
| `MemoryEventBus` | `EventBus` | `Map<type, handler[]>` + `history: DomainEvent[]` |

To switch to persistent storage: implement the same interfaces against PostgreSQL/Redis/DynamoDB, swap in the composition layer. Zero domain/engine changes.

### `engine/policy.ts` — Data-Driven Policy Engine

`RulePolicyEvaluator` implements `PolicyEvaluator`:
- `addRule(rule)` / `removeRule(name)` / `listRules()` — manage rules at runtime
- `evaluatePreStep(run, step)` — checks all rules against the step's action field
- Condition format: `"action:run_command"` → matches steps with that action name
- Effects: `Allow` → null, `RequireApproval` → return reason, `Deny` → throw `PolicyViolationError`

### `engine/audit.ts` — Immutable Audit Trail

`AuditService`:
- `log({ actor, action, resourceType, resourceId, detail })` → creates `AuditEntry` with timestamp, appends to repository
- `history(resourceType, resourceId)` → retrieves entries for a resource
- Append-only — entries are never edited or deleted

### `engine/learner.ts` — Execution Stats Aggregator

`Learner`:
- `record(executionRecord)` → stores metric
- `statsFor(actionName)` → returns `{ total, successes, failures, avgDurationMs }`

Feeds the Tool Stats widget in the UI — shows which tools are slow or failing.

### `engine/index.ts` — Engine Barrel Export

Re-exports everything from the engine subdirectory: all models, enums, events, errors, interfaces, services (AuditService, Learner, RulePolicyEvaluator), and memory adapters.

---

<a id="the-server-package"></a>
## The Server Package

The server package (`packages/server`) adds persistence, orchestration, messaging, and a REST API on top of the agent. It imports `@agent001/agent` as a workspace dependency.

**Runtime dependencies**: Fastify v5, better-sqlite3, @fastify/cors, @fastify/static, @fastify/websocket, dotenv.

<a id="server-core-files"></a>
### Core Server Files

#### `src/index.ts` — Server Startup

Creates the Fastify instance, registers all route modules, runs database migrations, wires the orchestrator, and starts listening on port 3001 (configurable via `PORT`). Also triggers auto-recovery of stale runs after startup.

#### `src/orchestrator.ts` — Agent Run Lifecycle Manager

`AgentOrchestrator` — the central coordinator for all agent runs:

- **`startRun(goal, agentId?)`** — creates run in DB, resolves tools + LLM, wraps with governance, starts agent in background. Broadcasts trace events via WebSocket.
- **`cancelRun(runId)`** — aborts a running agent via AbortController signal.
- **`resumeRun(runId)`** — resumes from checkpoint with idempotency guards (prevents duplicates).
- **`recoverStaleRuns()`** — on startup, finds interrupted runs, marks as crashed, auto-resumes from checkpoints.
- **`createNotification(opts)`** — saves to DB + broadcasts via WebSocket.

Tracks active runs in a `Map<runId, { controller, services, ... }>`. Wires domain event subscriptions to broadcast step updates, trace entries, and notifications in real-time.

#### `src/db.ts` — SQLite Persistence

Single-file database layer using better-sqlite3. Data lives in `~/.agent001/agent001.db`.

**Tables** (~9):
| Table | Purpose |
|-------|---------|
| `runs` | Agent run tracking (id, goal, status, answer, step_count, parent_run_id, etc.) |
| `audit_log` | Immutable action history |
| `checkpoints` | Run state snapshots for resume (messages JSON, iteration, step_counter) |
| `logs` | Per-run event logs (streamed to LiveLogs widget) |
| `layouts` | Saved dashboard configurations |
| `policy_rules` | Governance rules (persisted across restarts) |
| `token_usage` | LLM token consumption tracking |
| `notifications` | System notifications (type, title, message, actions JSON, read status) |
| Channel tables | conversations, outbound_messages, delivery_attempts, channel_configs |

**Key functions**: `saveRun()`, `getRun()`, `listRuns()`, `saveCheckpoint()`, `getCheckpoint()`, `saveNotification()`, `listNotifications()`, `findStaleRuns()`, `markRunCrashed()`, etc.

#### `src/tools.ts` — Tool Registry

Maps tool names to agent tool implementations. Resolves which tools an agent run should have based on agent definitions (custom tool sets per agent) or defaults (all tools).

#### `src/ws.ts` — WebSocket Broadcast

`broadcast(event)` — sends a JSON event to all connected WebSocket clients. Used by the orchestrator to stream trace entries, run status changes, step updates, and notifications in real-time.

<a id="channels"></a>
### Channels — Multi-Platform Messaging (8 files)

The `channels/` subdirectory implements inbound/outbound messaging for WhatsApp and Messenger:

| File | Purpose |
|------|---------|
| `types.ts` | `Channel`, `ChannelConfig`, `InboundMessage`, `OutboundMessage`, `DeliveryStatus` interfaces |
| `whatsapp.ts` | WhatsApp Business Cloud API — send messages, parse webhooks, HMAC-SHA256 signature validation |
| `messenger.ts` | Facebook Messenger Platform — same pattern, different API format |
| `queue.ts` | `MessageQueue` — FIFO per-user message serialization with retry on failure |
| `retry.ts` | `ChannelApiError`, `withRetry()` — exponential backoff for channel API calls (5 retries, 1s→60s) |
| `router.ts` | `MessageRouter` — routes inbound messages to agent runs, sends run results back as outbound messages |
| `store.ts` | `SqliteConversationStore`, `SqliteQueueStore` — persistence for conversations and delivery tracking |

**Flow**: Webhook arrives → `router.handleInbound()` → creates/reuses conversation → starts agent run → on completion → queues outbound reply → channel sends via API.

<a id="llm-registry"></a>
### LLM Registry (2 files)

| File | Purpose |
|------|---------|
| `llm/copilot.ts` | `CopilotClient` — GitHub Models API (OpenAI-compatible endpoint for Copilot Pro users) |
| `llm/registry.ts` | `buildLlmClient()` factory — creates LLM client based on provider config. Supports 4 providers: `copilot`, `openai`, `anthropic`, `local` (any OpenAI-compatible endpoint) |

<a id="rest-api-routes"></a>
### REST API Routes (8 files)

| File | Key Endpoints | Purpose |
|------|---------------|---------|
| `routes/runs.ts` | `GET/POST /api/runs`, `GET /api/runs/:id/trace`, `POST /api/runs/:id/resume`, `POST /api/runs/:id/cancel` | Run lifecycle management |
| `routes/agents.ts` | `GET/POST/PUT/DELETE /api/agents`, `GET /api/tools` | Agent definitions CRUD + tool registry |
| `routes/layouts.ts` | `GET/PUT /api/dashboard-state`, `CRUD /api/layouts` | Dashboard configuration persistence |
| `routes/policies.ts` | `GET/POST/DELETE /api/policies` | Governance rule management |
| `routes/notifications.ts` | `GET/POST /api/notifications/*` | Notification CRUD + action execution |
| `routes/llm.ts` | `GET/PUT /api/llm` | LLM provider configuration + hot-swap |
| `routes/usage.ts` | `GET /api/usage` | Token consumption tracking |
| `routes/webhooks.ts` | `GET/POST /webhooks/{whatsapp,messenger}`, `GET/POST /api/channels` | Chat platform webhook ingress |

---

<a id="the-ui-package"></a>
## The UI Package

The UI package (`packages/ui`) is a React 19 + Tailwind CSS v4 web dashboard built with Vite 6. It connects to the server via HTTP + WebSocket for real-time updates.

**Key dependencies**: React 19, Zustand 5 (state), react-grid-layout (draggable widgets), react-force-graph-2d (graph visualization), lucide-react (icons), Tailwind CSS v4.

<a id="ui-core-files"></a>
### Core UI Files

| File | Purpose |
|------|---------|
| `App.tsx` | Root component — renders Toolbar, Canvas (desktop) or MobileNav (mobile), WidgetModal |
| `store.ts` | Zustand global store — views, runs, widgets, logs, audit, notifications, modal state. Handles WebSocket events. |
| `api.ts` | HTTP client (raw fetch) + `createWs()` WebSocket subscription factory |
| `types.ts` | TypeScript interfaces: `Run`, `Step`, `AuditEntry`, `TraceEntry`, `WidgetType`, `Notification`, etc. |
| `util.ts` | Helpers: `randomId()`, `timeAgo()`, `truncate()`, `formatMs()`, `statusColor()` |
| `dashboardSync.ts` | Auto-saves dashboard layout to server (2s debounce), restores on startup |
| `index.css` | Global Tailwind styles + CSS theme variables (`--color-base: #09090b`, `--color-accent: #7B6FC7`, etc.) |

<a id="ui-components"></a>
### Components (12 files)

| Component | Purpose |
|-----------|---------|
| `Canvas.tsx` | Grid layout container using react-grid-layout — drag, resize, snap widgets |
| `Toolbar.tsx` | Top bar — logo, view tabs, notification bell, "Add Widget" button, settings menu |
| `ViewTabs.tsx` | Tab bar for multiple dashboard views (add/rename/remove) |
| `WidgetCatalog.tsx` | Modal for adding widgets — 9 types selectable |
| `WidgetFrame.tsx` | Chrome around each widget — drag handle, title, pop-out button, close button |
| `WidgetModal.tsx` | Pop-out any widget as a floating modal overlay |
| `NotificationPanel.tsx` | Bell icon with unread badge + dropdown notification list with action buttons |
| `Logo.tsx` | SVG brand mark — eyes glow green (online) or red (offline) with blink animation |
| `AgentEditor.tsx` | Agent CRUD modal — list, create, edit, delete agents with tool picker and prompt editor |
| `PolicyEditor.tsx` | Governance dashboard — tools & permissions, policy rules, blocklists, workspace settings |
| `UsageModal.tsx` | Token consumption stats — cumulative + per-run breakdown |
| `MobileNav.tsx` | Bottom nav for mobile — widget switcher with icons |

<a id="ui-widgets"></a>
### Widgets (9 types, 10 files)

The `widgets/index.ts` registry maps `WidgetType` → React component:

| Widget | Component | Purpose |
|--------|-----------|---------|
| `chat` | `AgentChat` | Send goals to agent — voice input (Web Speech API), agent picker, auto-scroll |
| `trace` | `AgentTrace` | Rich execution trace — ReAct loop visualization, expandable tool calls |
| `agent-viz` | `AgentViz` | Force-directed graph — react-force-graph-2d, draggable nodes, animated particles |
| `run-status` | `RunStatus` | Current run metadata — status badge, goal, timing, step counts, cancel/resume |
| `run-history` | `RunHistory` | List of past runs — click to select, inline cancel/resume buttons on hover |
| `step-timeline` | `StepTimeline` | Vertical timeline of steps — status icons, duration, expandable I/O, retry badge |
| `tool-stats` | `ToolStats` | Performance metrics per tool — call count, avg duration, failure rate, sorted bars |
| `audit-trail` | `AuditTrail` | Immutable audit log table — filterable by action/actor, expandable details |
| `live-logs` | `LiveLogs` | Real-time event stream — filter by level, auto-scroll, raw logs |

---

<a id="integration-boundary"></a>
## How Everything Connects — The Integration Boundary

The three packages have clear, narrow integration points:

```
packages/agent/src/lib.ts              ← The barrel export (the agent's public API)
    │
    │ exports: governance functions, engine types, enums, events, errors,
    │          services (AuditService, RulePolicyEvaluator, Learner),
    │          memory adapters, retry utilities
    │
    ▼
packages/server/src/orchestrator.ts    ← The primary consumer
    │
    │ imports @agent001/agent to:
    │   - Create governed agent runs (governance.ts functions)
    │   - Track state via AgentRun/Step entities
    │   - Emit domain events (runStarted, stepCompleted, etc.)
    │   - Evaluate policies (RulePolicyEvaluator)
    │   - Record audit + metrics (AuditService, Learner)
    │
    ▼
packages/ui/src/api.ts                 ← HTTP + WebSocket client
    │
    │ connects to server at localhost:3001:
    │   - REST API: fetch runs, agents, layouts, policies, notifications
    │   - WebSocket: real-time trace events, run status updates, notifications
```

**The agent package has zero runtime dependencies.** It exposes pure TypeScript — no framework, no database, no HTTP. The server adds infrastructure (Fastify, SQLite, WebSocket). The UI adds presentation (React, Tailwind).

### The `governance.ts` Composition Layer

The governance module is the bridge between the engine's domain model and the agent's tool execution:

```typescript
// createEngineServices() — wires engine components for a single run:
function createEngineServices() {
  return {
    runRepo:         new MemoryRunRepository(),
    auditService:    new AuditService(new MemoryAuditRepository()),
    policyEvaluator: new RulePolicyEvaluator(),
    learner:         new Learner(new MemoryExecutionRecordRepository()),
    eventBus:        new MemoryEventBus(),
  }
}
```

**`governTool(tool, services)`** — wraps any tool with governance:
1. Pre-step: create `Step`, evaluate policy → allow / require approval / deny
2. Execute: `tool.execute(args)` with timeout + retry
3. Post-step: record execution metrics, audit log, emit events

The tool doesn't know it's wrapped. The LLM doesn't know governance exists. Only governance.ts touches both worlds.

### Server → Agent Integration

The server's `AgentOrchestrator` is the orchestration layer:
- Creates `AgentRun` via engine functions (`createRun`, state transitions)
- Persists to SQLite (runs, checkpoints, logs tables)
- Wraps tools with governance + retry + timeout
- Streams events to WebSocket clients
- Handles resume/cancel/crash-recovery lifecycle

```
Server (orchestrator.ts)
  ├─ imports: createRun, governTool, runGovernedMode from @agent001/agent
  ├─ adds: SQLite persistence, WebSocket broadcast, checkpoint/resume
  └─ exposes: REST API (/api/runs, /api/agents, etc.)
```

### UI → Server Integration

The UI communicates exclusively through HTTP + WebSocket:
- `api.ts` — fetch wrapper for all REST endpoints
- `createWs()` — WebSocket connection with auto-reconnect
- `store.ts` — Zustand store processes WebSocket events to update React state

```
UI (store.ts)
  ├─ HTTP: GET/POST /api/runs, /api/agents, /api/layouts, /api/policies, etc.
  ├─ WS: receives trace, run-update, step-update, notification events
  └─ renders: 9 widget types, each subscribed to relevant store slices
```

### Why In-Memory Is Fine (And When It Isn't)

The agent's governance layer uses in-memory adapters (`MemoryRunRepository`, `MemoryAuditRepository`, etc.) for the engine's domain model. But the server adds SQLite persistence on top:

**In-memory (agent package):**
- A CLI `runGovernedMode()` session — one process, one run
- Audit trail + stats collected during session, printed at end
- Process exits → data gone (that's OK — it was already displayed)

**Persistent (server package):**
- SQLite stores runs, checkpoints, audit logs, token usage, notifications
- Enables: run history, crash recovery, multi-session queries, dashboard views
- The server wraps the in-memory engine services and also writes to SQLite

The agent package stays dependency-free. The server adds durability without changing the engine.

---

<a id="execution-flow"></a>
## Complete Execution Flow — Governed Mode

Two primary entry paths: the web dashboard (primary) and CLI (secondary).

### Web Dashboard Flow

When a user types a goal in the AgentChat widget:

#### 1. UI → Server API

```
AgentChat.tsx
  → handleSend(goal)
  → fetch("POST /api/runs", { goal, agentId? })
  → Server receives request
```

#### 2. Server Creates Run (orchestrator.ts)

```
orchestrator.startRun(goal, agentId):
  → saveRun({ id, goal, status: "running" })     ← SQLite
  → resolve tools for agent (custom or default)
  → create AbortController (for cancel support)
  → resolve LLM client (from registry)
  → createEngineServices()
  → governedTools = tools.map(t => governTool(t, services, state))
  → subscribe domain events → broadcast via WebSocket
  → agent = new Agent(llm, governedTools, config)
  → spawn async: agent.run(goal)                  ← runs in background
  → return { runId }                               ← immediate HTTP response
```

#### 3. Agent Loop (agent.ts — same as CLI)

```
agent.run(goal):
  → messages = [{ system: prompt }, { user: goal }]
  → iteration loop:
    → llm.chat(messages, tools)
    → if text response: done → return answer
    → if toolCalls: for each call:
      → governedTool.execute(args)                 ← governance intercept
      → push tool result to messages
    → checkpoint after each iteration              ← for crash recovery
```

#### 4. Real-Time Updates via WebSocket

```
As the agent runs, the orchestrator broadcasts events:
  → "trace" events (each LLM turn, tool call, tool result)
  → "run-update" (status changes)
  → "step-update" (step started/completed/failed)
  → "notification" (on completion, failure, approval required)

UI Zustand store handles these:
  → AgentTrace widget: renders execution trace
  → RunStatus widget: updates status badge + timing
  → StepTimeline widget: adds step entries
  → NotificationPanel: shows new notifications
  → AgentViz widget: animates graph nodes + particles
```

### CLI Flow

When a user runs from the command line:

#### 1. Startup (cli.ts)

```
main()
  → createLLMClient()          // reads API key from env, creates client
  → mode = "governed"
  → goal = "List all .ts files"
  → runGovernedMode(llm, goal)
    → allTools()               // [fetchUrl, readFile, writeFile, listDir, shell, think]
    → createEngineServices()   // creates Memory*: runRepo, auditRepo, recordRepo, eventBus
    → runGoverned(goal, llm, tools, services)
```

#### 2. Governance Setup (governance.ts)

```
runGoverned():
  → actor = "ai-agent"
  → createRun("agent-session", { goal })         ← AgentRun created (Pending)
  → startPlanning(run)                            ← Pending → Planning
  → startRunning(run, [])                         ← Planning → Running
  → runRepo.save(run)
  → eventBus.publish(runStarted)
  → auditService.log("agent.started", { goal, tools })
  → state = { run, actor, stepCounter: 0 }
  → governedTools = tools.map(t => governTool(t, services, state))
  → agent = new Agent(llm, governedTools, config)
  → agent.run(goal)
```

### 3. Agent Loop (agent.ts)

```
agent.run("List all .ts files"):
  → messages = [{ system: prompt }, { user: "List all .ts files" }]
  → iteration 0:
    → llm.chat(messages, tools)
    → LLM returns: { content: "I'll list the directory", toolCalls: [{ name: "run_command", args: { command: "find . -name '*.ts'" } }] }
    → messages.push({ assistant, toolCalls: [...] })
    → for call of toolCalls:
      → tool = this.tools.get("run_command")       ← this is the GOVERNED version
      → result = await tool.execute({ command: "find . -name '*.ts'" })
```

### 4. Governance Intercept (governance.ts → governTool wrapper)

```
governedTool.execute({ command: "find . -name '*.ts'" }):
  → createToolStep("run_command", args, state)    ← Step object created (Pending)
  → run.steps.push(step)
  → policyEvaluator.evaluatePreStep(run, step)   ← checks rules → null (allowed)
  → startStep(step)                                ← Pending → Running
  → eventBus.publish(stepStarted)
  → auditService.log("tool.invoked", { tool: "run_command", args })
  → startTime = performance.now()
  → result = await originalTool.execute(args)      ← ACTUAL shell execution happens here
  → durationMs = 45
  → completeStep(step, { result, durationMs })     ← Running → Completed
  → eventBus.publish(stepCompleted)
  → learner.record({ action: "run_command", success: true, durationMs: 45 })
  → auditService.log("tool.completed", { tool: "run_command", durationMs: 45 })
  → runRepo.save(run)
  → return result                                   ← back to agent loop
```

### 5. Completion

```
agent.run() continues:
  → messages.push({ tool, content: "src/types.ts\nsrc/agent.ts\n..." })
  → iteration 1:
    → llm.chat(messages, tools)
    → LLM returns: { content: "Here are the TypeScript files:\n...", toolCalls: [] }
    → no tool calls → answer = content
    → return answer

runGoverned() continues:
  → completeRun(run)                                ← Running → Completed
  → eventBus.publish(runCompleted)
  → auditService.log("agent.completed", { iterations: 1 })
  → collect stats per tool
  → return GovernedResult { answer, run, auditTrail, stats }

printGovernanceReport(result)                       ← formats and prints to console
```

---

<a id="design-patterns"></a>
## Design Patterns & Architectural Decisions

### 1. Hexagonal Architecture (Ports & Adapters)

```
                    Inner: Domain (pure logic)
                           ↓
                    Ports (interfaces)
                           ↓
                    Outer: Adapters (infrastructure)
```

**What it is**: The core business logic (domain + engine) depends only on abstract interfaces (ports). Concrete implementations (adapters) are plugged in from outside. Dependencies flow inward.

**Where it's applied**: The engine subdirectory defines port interfaces in `engine/interfaces.ts` — `RunRepository`, `AuditRepository`, `ExecutionRecordRepository`, `PolicyEvaluator`, `EventBus`. The engine services never import from `engine/memory.ts` directly. The composition layer (`governance.ts` or `orchestrator.ts`) is the only place that creates concrete adapter instances.

**Why it matters**: You can swap `MemoryRunRepository` for `PostgresRunRepository` by changing one line in the composition layer. The policy engine, audit service, learner — none of them need to change. They only depend on the interfaces.

### 2. Dependency Injection (Composition Root)

**What it is**: Dependencies are passed in via constructors or function parameters, not created internally. Composition happens in `governance.ts` (agent path) or `orchestrator.ts` (server path).

**Where it's applied**:
- `AuditService` receives `AuditRepository`
- `Learner` receives `ExecutionRecordRepository`
- `RulePolicyEvaluator` is standalone (rules managed via `addRule`/`removeRule`)
- `createEngineServices()` wires all engine dependencies for one run
- `AgentOrchestrator` (server) receives db, tools, LLM config

**Why it matters**: Every class can be tested in isolation. Pass mocks for every dependency. No global state, no singletons in core logic.

### 3. Strategy Pattern (Swappable Behaviors)

The same interface with multiple implementations:

| Interface | Implementations |
|-----------|----------------|
| `LLMClient` | `CopilotClient`, `OpenAIClient`, `AnthropicClient`, `LocalClient` (via registry) |
| `Tool.execute()` | filesystem, shell, fetch, think (each a different strategy) |
| `PolicyEvaluator` | `RulePolicyEvaluator` (could add ML-based, remote API, etc.) |
| `RunRepository` | `MemoryRunRepository` (swap for Postgres, DynamoDB) |
| `Channel` | `WhatsAppChannel`, `MessengerChannel` (channel messaging) |

**Why it matters**: Every extension point uses the same pattern. To add a new LLM: implement `LLMClient`. To add a Jira tool: implement `Tool`. To add a new channel: implement `Channel`. No core code changes.

### 4. Decorator Pattern (Governance Wrapping)

**What it is**: Enhance an object's behavior without modifying its interface. The wrapped object doesn't know it's wrapped.

**Where it's applied**: `governTool(tool) → Tool`. The returned tool has the same `{ name, description, parameters, execute() }` interface. But `execute()` now includes policy checks, audit, metrics, events _around_ the original execution.

```typescript
// The agent sees this:
tool.execute(args)

// What actually happens:
→ policyCheck()
  → auditLog("invoked")
    → originalTool.execute(args)
  → auditLog("completed")
→ recordMetrics()
```

**Why this is architecturally significant**: It's why the agent loop (`agent.ts`) is identical whether running governed or raw. The governance is a transparent wrapper. This clean separation means:
- The agent is simple and testable (mock LLM + bare tools)
- Governance can be added/removed without touching the agent
- Each concern (policy, audit, metrics) is composed, not embedded

### 5. Domain-Driven Design (DDD) — Why and How

#### What is an "Entity"?

In DDD, an **entity** is a thing with an identity that changes over time. Compare:

| | Entity | Plain data |
|---|---|---|
| **Has identity?** | Yes — `id: string` (UUID). Two runs with the same data but different IDs are different runs. | No — two objects with the same values are the same. |
| **Changes over time?** | Yes — an `AgentRun` starts as `Pending`, transitions to `Running`, ends as `Completed`. It's the same run throughout. | No — data is created, used, discarded. |
| **Has rules about how it changes?** | Yes — you can't go from `Pending` to `Completed` directly. | No — any field can be set to anything. |

In our code, entities are: `AgentRun`, `Step`. They each have an `id`, they change state over time, and their state changes are governed by rules.

Non-entities: `PolicyRule` (just a rule definition, no lifecycle), `AuditEntry` (immutable once created — it's a **value object** in DDD terms), `ExecutionRecord` (same — created once, never modified).

#### The Core DDD Idea: Business Rules Live With the Data They Protect

`models.ts` is the **single source of truth for what states are legal and how entities can change.** It answers questions like:

- Can a Step go from Pending to Completed? (**No** — must go through Running first)
- Can a Run be cancelled while waiting for approval? (**Yes**)

Without `models.ts`, these rules would be scattered across route handlers, the orchestrator, `governance.ts`, tests — everywhere. Anyone could write `step.status = "Completed"` from anywhere, and you'd need to _remember_ the rules. With `models.ts`, the rules are enforced — you literally cannot make an illegal move without getting an exception.

#### What models.ts Covers — The Board Game Analogy

Think of it as the **rule book for a board game**:

| What models.ts defines | Board game analogy |
|---|---|
| Interfaces (`AgentRun`, `Step`, `PolicyRule`, ...) | The **pieces** — what exists and what properties they have |
| Factory functions (`createRun`, ...) | The **setup** — how pieces enter the game in a valid initial state |
| Transition functions (`startStep`, `completeRun`, ...) | The **legal moves** — how pieces can change, with rules enforced |
| Transition maps (`STEP_TRANSITIONS`, `RUN_TRANSITIONS`) | The **rulebook** — which moves are allowed from which states |

It does NOT cover:
- **Where** pieces are stored (that's adapters/repositories)
- **What triggers** a move (that's orchestrator, governance, routes)
- **What happens after** a move (that's events, audit, learner)

This separation is the whole point. The rules exist independently of who invokes them. Whether the orchestrator calls `completeStep()` (engine REST API path) or `governance.ts` calls `completeStep()` (agent path) — the same guard runs, the same rules apply.

#### Why DDD? What Problem Does It Solve?

The alternative to understanding is seeing what goes wrong without it:

**Without DDD — rules scattered everywhere:**

```typescript
// In routes/runs.ts:
if (run.status === "Running") {
  run.status = "Completed"         // hope we remembered all the rules
  run.completedAt = new Date()
}

// In orchestrator.ts:
if (run.status === "Running" || run.status === "WaitingForApproval") {
  run.status = "Failed"            // wait, can we fail from WaitingForApproval?
  run.completedAt = new Date()     // did we forget this somewhere else?
}

// In governance.ts:
run.status = "Completed"           // oops, forgot to check current status
                                   // oops, forgot to set completedAt
```

Three files, three places where the "how to complete a run" logic is duplicated. Each slightly different. Bugs guaranteed.

**With DDD — rules in one place:**

```typescript
// In routes/runs.ts:
completeRun(run)        // enforces rules, sets completedAt

// In orchestrator.ts:
completeRun(run)        // same function, same rules

// In governance.ts:
completeRun(run)        // impossible to forget the rules — they're inside
```

One function, used everywhere. The rules can't be bypassed because `completeRun()` IS the only way to complete a run. Change the rule once → it changes everywhere.

#### What Would the Alternative Look Like?

**Alternative 1: No domain model (raw data + scattered logic)**

```typescript
// Just use plain objects, set fields directly
const run = { id: uuid(), status: "Pending", steps: [], ... }

// Every file that changes state does its own validation:
function completeRunInRoute(run: any) {
  if (run.status !== "Running") throw new Error("Can't complete")
  run.status = "Completed"
  run.completedAt = new Date()
}

// Same logic again in orchestrator, again in governance, again in tests...
```

This is what most quick scripts and small apps do. Works fine until the codebase grows and the rules get complex. Then you get bugs where one place enforces a rule and another doesn't.

**Alternative 2: OOP Rich Domain Model (class-based)**

```typescript
class AgentRun {
  private status: RunStatus

  complete(): void {
    if (this.status !== RunStatus.Running)
      throw new InvalidTransitionError(...)
    this.status = RunStatus.Completed
    this.completedAt = new Date()
  }
}

// Usage:
run.complete()
```

This is classic OOP DDD. Same idea, different style. The downside: classes don't serialize cleanly with `JSON.stringify()` (you need custom `toJSON`/`fromJSON`), they have `this` binding issues in callbacks, and they're harder to test (need to construct class instances with all required state).

**Alternative 3: Immutable + Event Sourcing**

```typescript
// State is never mutated. Every change creates a new version:
function completeRun(run: AgentRun): AgentRun {
  if (run.status !== RunStatus.Running) throw ...
  return { ...run, status: RunStatus.Completed, completedAt: new Date() }
}

// Or even: store events, rebuild state from them
const events = [RunCreated, PlanningStarted, RunStarted, RunCompleted]
const currentState = events.reduce(applyEvent, initialState)
```

Most sophisticated, most complex. Great for audit requirements (you have the full history of changes as events). Overkill for our use case.

**What we chose: Functional Domain Model (our approach)**

```typescript
// Entities are plain interfaces (data)
interface AgentRun { id: string, status: RunStatus, ... }

// Behavior is in free functions (not methods)
function completeRun(run: AgentRun): void { ... }
```

This gets the key DDD benefit (rules in one place, enforced on every call) without the downsides of classes (serialization issues, `this` binding) or immutability (propagation complexity). It's the pragmatic middle ground.

#### DDD Summary

| Concept | In our code | Purpose |
|---|---|---|
| **Entity** | `AgentRun`, `Step` | Things with identity that change over time |
| **Value Object** | `AuditEntry`, `ExecutionRecord`, `PolicyRule` | Immutable facts or definitions — created once, never modified |
| **Factory** | `createRun()`, `createAuditEntry()`, etc. | Ensures entities start in a valid state |
| **Guard/Transition** | `completeRun()`, `startStep()`, `failStep()`, etc. | Ensures entities can only move to legal states |
| **Domain Event** | `RunStarted`, `StepCompleted`, `ApprovalRequired`, etc. | Facts about what happened — for decoupled reactions |
| **Domain Error** | `InvalidTransitionError`, `PolicyViolationError` | Business-meaningful failures, not generic errors |
| **Repository** (port) | `RunRepository`, `AuditRepository`, `ExecutionRecordRepository` | Storage abstraction — domain doesn't know where data lives |

The engine subdirectory (`models.ts`, `enums.ts`, `events.ts`, `errors.ts`, `interfaces.ts`) has **zero infrastructure dependencies**. It doesn't import Fastify, database drivers, or even other packages. It's pure business logic. This is the DDD ideal: the domain is the center, everything else is plumbing around it.

### 6. State Machine (Guarded Transitions)

**Run states**:
```
Pending → Planning → Running → Completed
                        ↕          ↗
                  WaitingForApproval
                        ↘
                     Cancelled / Failed
```

**Step states**:
```
Pending → Running → Completed
   ↓         ↓  ↘
Skipped   Blocked  Failed → Running (retry)
```

**Implementation**: `STEP_TRANSITIONS` and `RUN_TRANSITIONS` are `Map<Status, Set<Status>>` objects. Every transition function checks the map before mutating. Illegal transitions throw `InvalidTransitionError` with the current and target states.

### 7. Observer Pattern (Domain Events)

**What it is**: Objects emit events when state changes. Subscribers react without coupling.

**Where it's applied**:
- Governance wrapper publishes `runStarted`, `stepCompleted`, `runFailed`, etc. for agent tool calls
- Server orchestrator subscribes to events and broadcasts them via WebSocket
- `EventBus.subscribe("run.completed", handler)` — subscribers are decoupled from publishers

**Why it matters**: Adding monitoring, webhooks, or analytics doesn't require changing the governance layer. Subscribe to events from outside.

### 8. Repository Pattern (Persistent Collections)

**What it is**: Abstract collection interfaces hiding storage details.

**Where it's applied**: All 3 repository interfaces in `engine/interfaces.ts`. Code works with `runRepo.save(run)` and `runRepo.get(id)` — never with `Map.set()` or `db.query()`.

**Why it matters**: Storage is a detail. The domain doesn't know if data is in a Map, PostgreSQL, or DynamoDB. Switching databases requires implementing the interfaces — no domain/engine changes.

### 9. Factory Pattern (Entity Construction)

**What it is**: Dedicated functions for creating complex objects with validation.

**Where it's applied**:
- `createRun(workflowId, input)` → generates ID, sets status to Pending, initializes timestamps
- `createAuditEntry(params)` → generates ID, sets timestamp

**Why it matters**: Constructor validation in one place. No scattered `{ id: randomUUID(), status: "Pending", ... }` throughout the codebase.

---

<a id="resilience"></a>
## Resilience, Notifications & Approval Workflow

This section documents the resilience features added to the governance layer, the notification system that surfaces events to users, and the approval workflow for sensitive operations.

### Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Tool Call (from agent loop)                                     │
│                                                                  │
│  governance.ts                                                   │
│  ┌──────────────────────────────────────────────────┐           │
│  │ 1. Policy check (allow / deny / require_approval) │           │
│  │ 2. If require_approval → emit ApprovalRequired    │           │
│  │    event → notification created → user notified   │           │
│  │ 3. Timeout wrapper (60s default, Promise.race)    │           │
│  │ 4. Retry wrapper (2 retries, exponential backoff) │           │
│  │    └─ only retries transient errors               │           │
│  │ 5. Audit log records attempt count                │           │
│  └──────────────────────────────────────────────────┘           │
│                                                                  │
│  orchestrator.ts                                                 │
│  ┌──────────────────────────────────────────────────┐           │
│  │ • Idempotent resume (prevents duplicate child     │           │
│  │   runs from being created)                        │           │
│  │ • Auto-recovery on startup (finds stale runs,     │           │
│  │   marks crashed, resumes from checkpoint)         │           │
│  │ • Creates notifications on:                       │           │
│  │   run.completed, run.failed, run.recovered,       │           │
│  │   approval.required                               │           │
│  └──────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────┘
```

<a id="tool-retry"></a>
### Tool Retry with Exponential Backoff

**File**: `packages/agent/src/retry.ts`

When a tool call fails with a transient error (timeout, network reset, rate limit), the governance layer retries it automatically using exponential backoff with jitter.

**Policy defaults** (`TOOL_RETRY_POLICY`):
| Parameter | Value | Purpose |
|---|---|---|
| `maxRetries` | 2 | Total attempts = 3 (1 initial + 2 retries) |
| `baseDelayMs` | 500 | First retry waits ~500ms |
| `maxDelayMs` | 5000 | Cap to prevent excessive waits |
| `backoffMultiplier` | 2 | Each retry doubles the delay |
| `jitterFactor` | 0.3 | Random spread up to 30% to prevent thundering herd |

**Which errors are retried?** Only transient ones — determined by `isRetryableError()`:
- Timeout / timed out
- Connection reset / refused / not found
- Socket hang up
- Rate limit (429)
- Server errors (500, 502, 503)

Non-transient errors (validation, permission, logic) fail immediately with **no retry**.

**How delay is computed**:
```
delay = min(baseDelayMs × backoffMultiplier^attempt, maxDelayMs) + jitter
```

**Result type**: `withToolRetry()` returns `{ success, value?, attempts, lastError? }` — the audit log records the attempt count so you can see which tool calls needed retries.

<a id="tool-timeouts"></a>
### Tool Timeouts

**File**: `packages/agent/src/governance.ts`

Every tool execution is wrapped in a `Promise.race` against a timeout:

```ts
const result = await Promise.race([
  withToolRetry(() => tool.execute(args), retryPolicy),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Tool execution timed out")), timeoutMs)
  ),
])
```

**Default timeout**: 60 seconds. Configurable per-tool via `GovernToolOptions.timeoutMs`.

If the timeout fires, the tool call fails with a `"Tool execution timed out"` error — which is itself retryable, so the retry wrapper will attempt the call again.

<a id="idempotent-resume"></a>
### Idempotent Resume

**File**: `packages/server/src/orchestrator.ts` → `resumeRun()`

The resume mechanism has three guards to prevent duplicate work:

1. **Active check**: If the run is currently in `activeRuns` map, return null (can't resume a live run).
2. **Completed check**: If the run's status is `completed`, return null.
3. **Duplicate check**: Scans recent runs for a child run (`parent_run_id === runId`) that's still active. If found, returns the existing child's ID instead of creating a new one.

This means clicking "Resume" multiple times, or auto-recovery racing with manual resume, can never create duplicate runs.

<a id="auto-recovery"></a>
### Auto-Recovery on Startup

**File**: `packages/server/src/orchestrator.ts` → `recoverStaleRuns()`

When the server starts, it finds all runs with status `running`, `pending`, or `planning` — these are stale from a previous crash.

**Recovery flow**:
1. `findStaleRuns()` queries the DB for runs in active states.
2. For each stale run:
   - Skip if it's somehow in the `activeRuns` map (defensive).
   - Call `markRunCrashed(runId)` — sets status to `failed` with error message "Server restarted — run interrupted".
   - Check for a checkpoint:
     - **Has checkpoint** → call `resumeRun()` → create `run.recovered` notification.
     - **No checkpoint** → create `run.failed` notification with "Resume" action.
3. Returns `{ recovered: string[], failed: string[] }` for logging.

**Notification actions**: Each notification includes buttons the user can click:
- `run.recovered` → "View Run" (navigates to the resumed run)
- `run.failed` with checkpoint → "Review" + "Resume"
- `run.failed` without checkpoint → "Review" only

<a id="approval-workflow"></a>
### Approval Workflow

When a policy evaluates to `require_approval`, the governance layer:

1. **Emits an `ApprovalRequired` domain event** via the event bus (defined in `engine/events.ts`):
   ```ts
   interface ApprovalRequired extends DomainEvent {
     type: "approval.required"
     runId: string
     stepName: string
     toolName: string
   }
   ```
2. **Orchestrator subscribes** to this event and creates a notification with type `approval.required`.
3. **The notification** appears in the bell icon dropdown with "Approve" / "Reject" action buttons.

The tool call is currently blocked (returns the policy deny message to the agent). Future enhancement: the tool call could await approval via a promise that resolves when the user clicks "Approve" in the notification panel.

<a id="notification-system"></a>
### Notification System

**Three layers**:

| Layer | File | What it does |
|---|---|---|
| **Database** | `packages/server/src/db.ts` | SQLite table (`notifications`) with CRUD: save, list, mark-read, mark-all-read, unread-count |
| **REST API** | `packages/server/src/routes/notifications.ts` | 5 endpoints for listing, reading, and executing notification actions |
| **UI** | `packages/ui/src/components/NotificationPanel.tsx` | Bell icon with unread badge, dropdown panel with notification list |

**API endpoints**:
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/notifications` | List notifications (default 50, max 200) |
| GET | `/api/notifications/unread-count` | Get unread count for badge |
| POST | `/api/notifications/:id/read` | Mark single notification read |
| POST | `/api/notifications/read-all` | Mark all notifications read |
| POST | `/api/notifications/:id/action` | Execute a notification action (resume-run, cancel-run, view-run) |

**Real-time delivery**: When a notification is created via `createNotification()`, it is both persisted to SQLite and broadcast over WebSocket as a `"notification"` event. The Zustand store (`handleWsEvent`) picks this up and adds it to `notifications[]` + increments `unreadCount`.

**Notification types**:
| Type | When | Actions |
|---|---|---|
| `run.completed` | Run finishes successfully | View Run |
| `run.failed` | Run fails | View Run, Resume |
| `run.recovered` | Stale run auto-resumed on startup | View Run |
| `approval.required` | Policy requires human approval | Approve*, Reject* |

**UI details**: The bell icon sits in the top-right corner of the Toolbar. An unread count badge (red circle) appears when there are unread notifications. Clicking opens a dropdown with:
- Notification type icon (color-coded: green=completed, red=failed, purple=recovered, amber=approval)
- Title + message + time-ago
- Action buttons per notification
- "Mark all read" button in the header

<a id="modal-widget-viewer"></a>
### Modal Widget Viewer

**File**: `packages/ui/src/components/WidgetModal.tsx`

When a notification action references a widget type that isn't in the user's current dashboard layout, the widget opens as a modal overlay instead of navigating away.

**How it works**:
1. Zustand store holds `modalWidget: { type, title, props? } | null`.
2. Calling `openModalWidget({ type, title })` shows the modal.
3. The modal renders the requested widget at full size inside a rounded overlay (90vw, max-w-2xl, 70vh).
4. An "Add to view" button lets the user permanently add the widget to their dashboard.
5. Backdrop click or X button closes the modal.

### Widget Inline Actions

Two existing widgets were enhanced with inline action buttons:

- **RunHistory** (`packages/ui/src/widgets/RunHistory.tsx`): Hover over a run row to see Cancel (for active runs) or Resume (for failed runs) buttons.
- **StepTimeline** (`packages/ui/src/widgets/StepTimeline.tsx`): Steps that were retried show a badge with the retry count (e.g., "2 attempts").

---

<a id="swapping"></a>
## Why This Architecture Makes Swapping Easy

### Example: Swapping the Engine for Temporal

[Temporal](https://temporal.io) is a workflow orchestration platform. It provides what our engine provides — run tracking, retries, state persistence, audit — but as an external service instead of in-process code.

**What would change:**

| Component | Current | With Temporal | Amount of Change |
|-----------|---------|---------------|-----------------|
| `governance.ts` | Wraps tools with in-memory engine | Wraps tools as Temporal activities | **Rewrite this file** |
| `agent.ts` | Unchanged | Unchanged | **Zero** |
| `cli.ts` | Unchanged | Unchanged | **Zero** |
| `types.ts` | Unchanged | Unchanged | **Zero** |
| All tools | Unchanged | Unchanged | **Zero** |
| LLM clients | Unchanged | Unchanged | **Zero** |
| Server (orchestrator) | Minor adjustments | Temporal client instead of in-process | **Moderate** |
| UI | Unchanged | Unchanged | **Zero** |

**Why it's mostly one file**: The integration boundary is one function signature: `tool.execute(args) → Promise<string>`. In our engine, that function is wrapped with in-process policy checks and audit. In Temporal, that function becomes a Temporal _activity_ inside a Temporal _workflow_. The agent still calls `tool.execute(args)` either way.

### Example: Swapping Memory Repos for PostgreSQL

```typescript
// governance.ts — before:
const runRepo = new MemoryRunRepository()

// governance.ts — after:
const runRepo = new PostgresRunRepository(pool)
```

`PostgresRunRepository` implements `RunRepository` (same `save()`, `get()`). The governance, agent, server — none of them change. They import `RunRepository` (the interface), not `MemoryRunRepository` (the implementation).

### Why This Works

It's not magic — it's the **dependency inversion principle** consistently applied:

1. **Core logic depends on abstractions** (interfaces in `engine/interfaces.ts`)
2. **Details depend on abstractions** (adapters in `engine/memory.ts` implement interfaces)
3. **Composition happens once** (`governance.ts` for agent, `orchestrator.ts` for server)
4. **Boundaries are narrow** (one function signature, one interface)

When every boundary is an interface, swapping an implementation is always a localized change. The rest of the system doesn't know and doesn't care.

---

<a id="testing-strategy"></a>
## Testing Strategy

71 tests across 4 test files in 2 packages. All tests run with `vitest` — no API keys needed.

### Agent Tests — `packages/agent/tests/` (31 tests)

**No API keys needed.** Tests use a mock `scriptedLLM()` that returns pre-programmed responses:

```typescript
function scriptedLLM(responses: LLMResponse[]): LLMClient {
  let i = 0
  return { chat: async () => responses[i++] }
}
```

Combined with `echoTool()` (returns its input) and `failingTool()` (always throws), this tests the full governance lifecycle.

#### `governance.test.ts` (18 tests)

| Category | Tests | What's Verified |
|----------|-------|----------------|
| Run tracking | 4 | AgentRun created, steps tracked, run completes/fails, persisted to repo |
| Audit trail | 4 | agent.started/completed logged, tool.invoked/completed per call, failures logged, actor recorded |
| Policies | 3 | Deny blocks tool, RequireApproval blocks tool, no policy = allow |
| Execution records | 3 | Metrics recorded in learner, failures tracked, per-tool stats returned |
| Domain events | 4 | run.started/completed emitted, step.started/completed per tool, step.failed on error, run.failed on agent failure |

#### `retry.test.ts` (13 tests)

| Category | Tests | What's Verified |
|----------|-------|----------------|
| Retry logic | 5 | Successful retry, max retries exhausted, exponential backoff timing |
| Error classification | 5 | Retryable errors (timeout, network, 429, 5xx) vs non-retryable (validation, permission) |
| Integration | 3 | Retry within governance wrapper, timeout + retry combo, audit records attempt count |

### Server Tests — `packages/server/tests/` (40 tests)

#### `channels.test.ts` (30 tests)

| Category | Tests | What's Verified |
|----------|-------|----------------|
| WhatsApp | 8 | Message sending, webhook parsing, HMAC-SHA256 signature validation, error handling |
| Messenger | 7 | Message sending, webhook parsing, different payload formats |
| MessageQueue | 5 | FIFO ordering, per-user serialization, retry on failure, queue drain |
| MessageRouter | 5 | Inbound routing, conversation creation/reuse, outbound reply queuing |
| SqliteStores | 5 | ConversationStore + QueueStore CRUD, delivery tracking |

#### `notifications.test.ts` (10 tests)

| Category | Tests | What's Verified |
|----------|-------|----------------|
| CRUD | 4 | Save, list, mark-read, mark-all-read, unread-count |
| Actions | 3 | Resume-run, cancel-run, view-run action execution |
| WebSocket | 3 | Real-time broadcast, notification payload shape, type filtering |

### Running Tests

```bash
# All tests (from repo root)
npm test

# Agent tests only
npm test -w packages/agent

# Server tests only
npm test -w packages/server
```

---

<a id="dependency-flow"></a>
## Dependency Flow

```
packages/ui (React + Tailwind)
    │  HTTP + WebSocket to
    ▼
packages/server (Fastify + SQLite)
    │  imports @agent001/agent
    ▼
packages/agent (zero runtime deps)
    ├─ src/agent.ts        (LLM loop)
    ├─ src/governance.ts   (wraps tools with engine)
    ├─ src/engine/         (domain model + services)
    └─ src/lib.ts          (barrel export)
```

```
Server (orchestrator.ts — run lifecycle manager)
    │  creates
    ▼
Governance (governance.ts — wraps tools with engine substrate)
    │  creates                    │  imports from
    ▼                             ▼
Agent (agent.ts — LLM loop)    engine/ (via lib.ts barrel)
    │  calls                      │  provides
    ▼                             ▼
Governed Tools                  Domain types, services, adapters
    │  wraps
    ▼
Raw Tools (filesystem, shell, fetch, think)
```

**The dependency rule**: inner layers never depend on outer layers. The engine subdirectory has zero imports from governance, agent, server, or UI. Governance depends on the engine. The agent depends on governance (through tool wrapping). The server depends on the agent package. The UI depends only on the server's HTTP/WebSocket API.
