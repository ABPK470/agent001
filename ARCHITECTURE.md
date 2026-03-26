# Architecture & Design — The Complete Technical Guide

> **Purpose**: This document explains every file, how the pieces connect, what happens at runtime, and why the architecture is designed this way. Written for learning — not just _what_, but _why_.

---

## Table of Contents

1. [What This Platform Is](#what-this-platform-is)
2. [Project Structure — The 10,000-Foot View](#project-structure)
3. [User Perspective — What Happens When You Run It](#user-perspective)
4. [The Agent Package — Every File Explained](#the-agent-package)
5. [The Engine Package — Every File Explained](#the-engine-package)
6. [How Everything Connects — The Integration Boundary](#integration-boundary)
7. [Complete Execution Flow — Governed Mode](#execution-flow)
8. [Design Patterns & Architectural Decisions](#design-patterns)
9. [Why This Architecture Makes Swapping Easy](#swapping)
10. [Testing Strategy](#testing-strategy)
11. [Dependency Flow](#dependency-flow)

---

## What This Platform Is

agent001 is two things in one:

1. **An AI agent** — an LLM (GPT-4o, Claude, etc.) with tools (filesystem, shell, web fetch) running in a Think → Act → Observe loop.
2. **A governance engine** — a hexagonal workflow engine that wraps every tool call with policy checks, audit trails, run tracking, domain events, and execution metrics.

The key insight: **the agent runs _on_ the engine.** The engine is the agent's substrate. Every time the LLM calls a tool, that call passes through the engine's governance layer before the tool actually runs. This gives you:

- An **immutable audit trail** of every action the AI took
- **Policy enforcement** — block or require approval for dangerous operations
- **Run tracking** — the entire agent session as a first-class WorkflowRun with Steps
- **Domain events** — every state change emits an event for monitoring/webhooks
- **Execution metrics** — timing, success rates, failure counts per tool

```
┌─────────────────────────────────────────────────────────────┐
│                     USER / CLI                              │
│  "Summarize the README and list all TypeScript files"       │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                   AGENT PACKAGE                              │
│                                                              │
│   cli.ts ──→ governance.ts ──→ agent.ts                     │
│                   │                │                          │
│            wraps tools         LLM + Loop                    │
│            with engine         (Think→Act→Observe)           │
│                   │                │                          │
│   ┌───────────────▼────────────────▼──────────────────┐     │
│   │         Tool calls (governed)                      │     │
│   │  ┌──────────┐  ┌──────────┐  ┌──────────┐        │     │
│   │  │read_file │  │run_command│  │fetch_url │  ...   │     │
│   │  └────┬─────┘  └────┬─────┘  └────┬─────┘        │     │
│   │       │              │              │              │     │
│   └───────┼──────────────┼──────────────┼──────────────┘     │
│           │              │              │                     │
└───────────┼──────────────┼──────────────┼────────────────────┘
            │              │              │
┌───────────▼──────────────▼──────────────▼────────────────────┐
│                   ENGINE PACKAGE (governance substrate)       │
│                                                              │
│   Policy check  →  Audit log  →  Execute  →  Record metrics │
│       │                │              │             │         │
│   PolicyEvaluator  AuditService  actual tool   Learner      │
│       │                │                           │         │
│   Domain Events ←──── EventBus ←──── RunRepository          │
│                                                              │
│   ┌─────────────────────────────────────────────────┐       │
│   │  Ports (interfaces) → Adapters (in-memory)       │       │
│   │  Swap for Postgres/Redis/SQS without code change │       │
│   └─────────────────────────────────────────────────┘       │
└──────────────────────────────────────────────────────────────┘
```

---

<a id="project-structure"></a>
## Project Structure — The 10,000-Foot View

```
agent001/                          ← npm workspaces monorepo root
├── package.json                   ← workspaces: ["packages/*"], shared scripts
├── ARCHITECTURE.md                ← this file
├── README.md                      ← quickstart, usage examples, governance report demo
│
├── packages/agent/                ← THE AGENT — LLM + tools + governance integration
│   ├── package.json               ← depends on @agent001/engine (workspace link)
│   ├── tsconfig.json              ← strict TS, ES2022 target
│   ├── vitest.config.ts           ← test runner config
│   ├── src/
│   │   ├── types.ts               ← core vocabulary: Message, Tool, LLMClient, ToolCall
│   │   ├── agent.ts               ← THE agent loop (~40 lines of core logic)
│   │   ├── governance.ts          ← THE integration layer — wraps tools with engine
│   │   ├── cli.ts                 ← entry point — governed/raw modes, REPL + one-shot
│   │   ├── logger.ts              ← colored console output
│   │   ├── llm/
│   │   │   ├── openai.ts          ← OpenAI Chat Completions client (raw fetch)
│   │   │   └── anthropic.ts       ← Anthropic Messages API client (raw fetch)
│   │   └── tools/
│   │       ├── filesystem.ts      ← read_file, write_file, list_directory (sandboxed)
│   │       ├── shell.ts           ← run_command (30s timeout)
│   │       ├── fetch-url.ts       ← fetch_url (HTML stripping, 15s timeout)
│   │       └── think.ts           ← think (chain-of-thought passthrough)
│   └── tests/
│       └── governance.test.ts     ← 18 tests (mock LLM, no API keys needed)
│
└── packages/engine/               ← THE ENGINE — hexagonal workflow engine
    ├── package.json               ← exports: { ".": "./src/lib.ts" }
    ├── tsconfig.json              ← strict TS, ES2022 target
    ├── vitest.config.ts           ← test runner config
    ├── src/
    │   ├── domain/                ← pure business entities, zero dependencies
    │   │   ├── models.ts          ← Workflow, WorkflowRun, Step, state machines
    │   │   ├── enums.ts           ← WorkflowStatus, RunStatus, StepStatus, etc.
    │   │   ├── events.ts          ← domain events (RunStarted, StepCompleted, etc.)
    │   │   ├── errors.ts          ← domain error hierarchy
    │   │   └── workflow-schema.ts ← WorkflowDefinition, StepDefinition (declarative)
    │   ├── ports/                 ← interfaces only — no implementations
    │   │   ├── repositories.ts    ← 5 repository interfaces
    │   │   └── services.ts        ← PolicyEvaluator, EventBus, WorkQueue
    │   ├── engine/                ← generic execution engine
    │   │   ├── orchestrator.ts    ← core loop: plan → condition → expression → policy → execute
    │   │   ├── planner.ts         ← DAG topological sort (Kahn's algorithm)
    │   │   ├── expression.ts      ← {{input.x}} and {{steps.prev.output.y}} resolver
    │   │   ├── executor.ts        ← ActionRegistry (plugin map) + StepExecutor (dispatch)
    │   │   └── learner.ts         ← execution stats aggregator
    │   ├── governance/            ← policy + approval + audit
    │   │   ├── policy-engine.ts   ← RulePolicyEvaluator (data-driven rules)
    │   │   ├── approval-service.ts← manage and resolve approvals
    │   │   └── audit-service.ts   ← immutable audit trail
    │   ├── adapters/              ← concrete implementations (swap these)
    │   │   ├── memory-repositories.ts ← Map/Array-backed repos (5 classes)
    │   │   ├── memory-event-bus.ts    ← in-process pub/sub with history
    │   │   └── memory-queue.ts        ← synchronous pass-through queue
    │   ├── actions/
    │   │   └── builtin.ts         ← http.request, transform, filter, noop, log
    │   ├── api/                   ← HTTP API (Fastify)
    │   │   ├── app.ts             ← Fastify factory
    │   │   ├── container.ts       ← DI container — single composition root
    │   │   ├── schemas.ts         ← Zod validation schemas
    │   │   └── routes/
    │   │       ├── workflows.ts   ← CRUD for workflows
    │   │       ├── runs.ts        ← start/list/get/resume runs
    │   │       ├── approvals.ts   ← list pending, resolve approval
    │   │       └── actions.ts     ← list registered action handlers
    │   ├── lib.ts                 ← barrel export — public API for agent integration
    │   └── index.ts               ← server entry (createApp + listen)
    └── tests/
        ├── helpers.ts             ← test utilities (buildTestDeps, mock handlers)
        ├── domain/models.test.ts  ← 12 tests (state transitions)
        ├── engine/
        │   ├── expression.test.ts ← 16 tests
        │   ├── planner.test.ts    ← 7 tests
        │   ├── executor.test.ts   ← 8 tests
        │   └── orchestrator.test.ts
        ├── governance/governance.test.ts ← 17 tests
        └── api/api.test.ts        ← 15 tests (HTTP integration)
```

**Why two packages?** Separation of concerns. The engine knows nothing about LLMs or AI. The agent knows nothing about workflow DAGs or HTTP APIs. They meet at one narrow seam: `governance.ts` wraps the agent's tools using the engine's services. This means you could:
- Use the engine alone as a REST workflow server (no AI)
- Use the agent alone with `AGENT_MODE=raw` (no governance)
- Swap the engine for Temporal/Inngest and only `governance.ts` changes

---

<a id="user-perspective"></a>
## User Perspective — What Happens When You Run It

### Starting the Agent

```bash
# Governed mode (default) — full audit + policies + tracking
ANTHROPIC_API_KEY=sk-ant-... npm start -w packages/agent

# One-shot mode (non-interactive)
npm start -w packages/agent -- "Summarize the README"

# Raw mode — bare agent loop, no governance
AGENT_MODE=raw OPENAI_API_KEY=sk-... npm start -w packages/agent
```

### What You See (Governed Mode)

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

### What Happens Under the Hood

Here's the exact chain of function calls when you type a goal:

1. `cli.ts → main()` reads env vars, creates LLM client
2. `createEngineServices()` builds in-memory engine infrastructure
3. `setupDefaultPolicies()` (hook for adding rules)
4. User types goal → `runGoverned(goal, llm, tools, services)` is called
5. `governance.ts` creates a `WorkflowRun`, wraps each tool with `governTool()`
6. `new Agent(llm, governedTools)` — the agent gets the wrapped tools
7. `agent.run(goal)` starts the Think → Act → Observe loop
8. LLM decides to call `list_directory` → governance wrapper intercepts:
   - Policy check (is this tool allowed?)
   - Audit log (`tool.invoked`)
   - Tool actually runs
   - Step marked completed
   - Execution metric recorded
   - Domain event emitted (`step.completed`)
   - Audit log (`tool.completed`)
9. Result fed back to LLM → LLM returns text → loop ends
10. `printGovernanceReport()` displays the full report

### Starting the Engine REST Server

```bash
npm start -w packages/engine
# → Fastify listening on http://0.0.0.0:3000/

# Create and run a workflow:
curl -X POST http://localhost:3000/workflows \
  -H 'Content-Type: application/json' \
  -d '{"name":"hello","steps":[{"id":"s1","name":"Say hi","action":"log","input":{"message":"Hello!"}}]}'

curl -X POST http://localhost:3000/workflows/<id>/runs
```

---

<a id="the-agent-package"></a>
## The Agent Package — Every File Explained

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

**This is the most important file in the entire project.** It's where the agent package and the engine package meet. ~330 lines that turn a bare agent into a governed agent.

#### What It Does

1. **Creates engine infrastructure** (`createEngineServices()`):
   - In-memory repositories for runs, audit, execution records
   - Event bus, policy evaluator, learner

2. **Wraps each tool** (`governTool(tool, services, state) → Tool`):
   The returned tool has the same interface but every `execute()` now goes through:
   ```
   Policy check (can this tool run?)
     ↓ denied → audit "tool.denied" → return "DENIED: ..."
     ↓ needs approval → audit "tool.blocked" → return "BLOCKED: ..."
     ↓ allowed → continue
   Start step + emit stepStarted event
   Audit "tool.invoked"
   Execute the actual tool (original tool.execute())
   Complete step + emit stepCompleted event
   Record execution metric (to Learner)
   Audit "tool.completed"
   Save run to repository
   Return result to agent
   ```

3. **Runs the governed agent** (`runGoverned(goal, llm, tools, services)`):
   - Creates a `WorkflowRun` (the agent session becomes a tracked run)
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
  run: WorkflowRun    // the current run (steps get pushed onto this)
  actor: string       // who's running the agent
  stepCounter: number // monotonically increasing step counter
}
```

All wrapped tools share the same `RunState`. When tool A executes and adds a step, tool B (called later) sees it because they share the same `run` object. This is how the governance layer builds up a complete picture of the agent's session.

---

<a id="the-engine-package"></a>
## The Engine Package — Every File Explained

The engine is a standalone workflow execution platform built with hexagonal architecture. It can run independently as a REST API server, or be used as a library by the agent package.

### Domain Layer — `src/domain/`

The innermost layer. Pure TypeScript, **zero** infrastructure dependencies. Only `crypto.randomUUID()` from Node.

#### `domain/models.ts` — Domain Entities

The core business objects with guarded state machines:

**`Workflow`** — a workflow definition container
- States: `Draft → Active → Archived`
- Factory: `createWorkflow(definition)` → creates with Draft status
- Transitions: `activateWorkflow()`, `archiveWorkflow()`

**`WorkflowRun`** — a single execution of a workflow
- States: `Pending → Planning → Running → Completed | Failed | Cancelled`
- Also: `Running → WaitingForApproval → Running` (for policy pauses)
- Factory: `createRun(workflowId, input)`
- Transitions: `startPlanning()`, `startRunning(steps)`, `waitForApproval()`, `resumeRun()`, `completeRun()`, `failRun()`, `cancelRun()`
- Holds: `steps: Step[]` — the ordered list of steps, `input`, timestamps

**`Step`** — a single unit of work within a run
- States: `Pending → Running → Completed | Failed`
- Also: `Pending → Skipped`, `Pending → Blocked`, `Failed → Running` (retry)
- Transitions: `startStep()`, `completeStep(output)`, `failStep(error)`, `skipStep()`, `blockStep()`
- Holds: `action`, `input`, `output`, `error`, `order`, timestamps

**`ApprovalRequest`** — a human intervention point
- States: `Pending → Approved | Rejected`
- Factory: `createApprovalRequest({ runId, stepId, reason, policyName })`
- Transitions: `approveRequest(user)`, `rejectRequest(user)`

**`PolicyRule`** — a governance rule definition
- Shape: `{ name, effect, condition, parameters }`
- Used by `RulePolicyEvaluator` to check steps before execution

**`AuditEntry`** — an immutable log record
- Factory: `createAuditEntry({ actor, action, resourceType, resourceId, detail })`

**`ExecutionRecord`** — a performance metric
- Fields: `runId, stepId, action, success, durationMs, result, error`
- Used by `Learner` for stats aggregation

**Every state transition is guarded**. The `STEP_TRANSITIONS` and `RUN_TRANSITIONS` maps declare legal moves. If code tries `completeStep()` on a step that's still `Pending` (not `Running`), it throws `InvalidTransitionError`. This catches bugs immediately instead of producing corrupt state.

#### `domain/enums.ts` — Status Types

Simple string enums. Six of them:

| Enum | Values |
|------|--------|
| `WorkflowStatus` | Draft, Active, Archived |
| `RunStatus` | Pending, Planning, Running, WaitingForApproval, Completed, Failed, Cancelled |
| `StepStatus` | Pending, Running, Completed, Failed, Skipped, Blocked |
| `ApprovalStatus` | Pending, Approved, Rejected, Expired |
| `PolicyEffect` | Allow, RequireApproval, Deny |
| `Severity` | Info, Warning, Error, Critical |

#### `domain/events.ts` — Domain Events

Immutable event objects emitted at state transitions:

| Event | Emitted When | Payload |
|-------|-------------|---------|
| `RunStarted` | Run begins | runId, workflowId |
| `RunCompleted` | Run finishes successfully | runId |
| `RunFailed` | Run fails | runId, error |
| `StepStarted` | Step begins execution | runId, stepId |
| `StepCompleted` | Step finishes successfully | runId, stepId |
| `StepFailed` | Step fails | runId, stepId, error |
| `ApprovalRequested` | Policy requires approval | approvalId, runId, stepId, reason |
| `ApprovalResolved` | Human approves/rejects | approvalId, approved, user |

All events have `eventId` (UUID), `type` (string discriminator), and `occurredAt` (Date).

**Implementation detail**: The `base<T extends string>(type: T)` generic factory preserves the literal type of the event type string, enabling type-safe event subscriptions.

#### `domain/errors.ts` — Domain Error Hierarchy

All extend `DomainError` (which extends `Error`):

| Error | When Thrown |
|-------|-----------|
| `WorkflowNotFoundError` | GET/POST with unknown workflow ID |
| `RunNotFoundError` | GET/POST with unknown run ID |
| `InvalidTransitionError` | Illegal state machine transition (e.g., Complete → Running) |
| `PolicyViolationError` | Policy with `Deny` effect matched |
| `ApprovalRequiredError` | Policy with `RequireApproval` effect matched |
| `ActionNotFoundError` | Step references unregistered action handler |
| `ExpressionError` | `{{...}}` expression can't be resolved |
| `ConnectorError` | External system integration failure |

**Design decision**: Custom errors instead of generic `Error("something")`. This enables `instanceof` checks for control flow. The governance layer catches `PolicyViolationError` differently from `ApprovalRequiredError` — one means "deny entirely", the other means "pause and wait for human".

#### `domain/workflow-schema.ts` — Declarative Workflow Schema

The data structure for defining workflows:

```typescript
interface WorkflowDefinition {
  name: string
  description?: string
  inputSchema?: Record<string, ParameterDef>
  steps: StepDefinition[]
  tags?: string[]
}

interface StepDefinition {
  id: string                    // unique within workflow
  name: string                  // human-readable
  action: string                // handler name (e.g., "http.request")
  input: Record<string, unknown> // may contain {{expressions}}
  dependsOn?: string[]          // IDs of prerequisite steps (DAG edges)
  condition?: string            // evaluated at runtime (e.g., "{{input.amount}} > 100")
  retryPolicy?: RetryPolicy     // { maxAttempts, backoffMs }
  timeoutMs?: number
  onError?: "fail" | "skip" | "continue"
}
```

**This is the declarative core.** Workflows are data, not code. The engine interprets them at runtime. Add new capabilities by registering action handlers, not by modifying the engine.

### Port Layer — `src/ports/`

Interfaces that define what the engine _needs_ from infrastructure. The engine imports these; adapters implement them.

#### `ports/repositories.ts` — Storage Contracts

Five repository interfaces, all follow the same pattern: `save()`, `get()`, `list*()`:

| Interface | Stores | Key Methods |
|-----------|--------|-------------|
| `WorkflowRepository` | Workflow entities | `save`, `get`, `listAll`, `delete` |
| `RunRepository` | WorkflowRun entities | `save`, `get`, `listByWorkflow` |
| `ApprovalRepository` | ApprovalRequests | `save`, `get`, `listPending(runId?)` |
| `AuditRepository` | AuditEntries | `append`, `listByResource(type, id)` |
| `ExecutionRecordRepository` | ExecutionRecords | `append`, `listByRun`, `listByAction` |

#### `ports/services.ts` — Service Contracts

| Interface | Purpose | Contract |
|-----------|---------|----------|
| `PolicyEvaluator` | Check step before execution | `evaluatePreStep(run, step)`: null = allow, string = needs approval, throw = deny |
| `EventBus` | Publish/subscribe domain events | `publish(event)`, `subscribe(type, handler)` |
| `WorkQueue` | Distribute step jobs | `enqueue(job)`, `process(handler)` |

**The `PolicyEvaluator` contract is clever**: Three outcomes from one method, using the type system:
- Return `null` → step is allowed
- Return `string` → step needs approval (string is the reason)
- Throw `PolicyViolationError` → step is denied

### Engine Layer — `src/engine/`

The generic execution engine. Interprets workflow definitions, dispatches to handlers, records results.

#### `engine/orchestrator.ts` — The Execution Loop

The orchestrator takes dependencies via constructor injection (`OrchestratorDeps`):
```typescript
interface OrchestratorDeps {
  executor: StepExecutor
  policyEvaluator: PolicyEvaluator
  learner: Learner
  runRepo: RunRepository
  approvalRepo: ApprovalRepository
  eventBus: EventBus
}
```

**`startRun(workflow, input)`**:
1. `createRun()` → Pending
2. `startPlanning()` → Planning
3. `planSteps()` → topological sort → Step[]
4. `startRunning(steps)` → Running
5. `executeSteps(run)` → the loop

**`executeSteps(run)`** — the core loop for each step:
```
for step in run.steps:
  if already completed/skipped → skip
  if condition exists and evaluates false → skipStep()
  resolveExpressions(step.input, context) → resolved input
  policyEvaluator.evaluatePreStep(run, step)
    → if needs approval: blockStep() → waitForApproval() → throw ApprovalRequiredError
  startStep(step)
  executor.executeAndRecord(action, input, ctx)
    → on success: completeStep(output), update context, emit stepCompleted
    → on failure: check onError strategy
        "skip" → skipStep()
        "continue" → failStep(), continue loop
        default → failStep(), failRun(), emit events, return
```

**The expression context is updated as steps complete.** Step B can reference `{{steps.stepA.output.data}}` because the orchestrator updates the context object after each step completes. This is how data flows between steps without explicit plumbing.

#### `engine/planner.ts` — DAG Topological Sort

Converts `WorkflowDefinition.steps` into ordered `Step[]` instances:

1. Build adjacency list from `dependsOn` edges
2. Calculate in-degree for each step
3. Start queue with zero in-degree steps (no dependencies)
4. Process: dequeue step → add to sorted → decrement dependents' in-degree → enqueue newly zero
5. If sorted count ≠ total count → **cycle detected** → throw error

This is Kahn's algorithm — a well-known graph algorithm for topological sorting. It guarantees that every step runs after its dependencies are satisfied.

**Also validates**: Unknown dependency references throw immediately rather than failing at runtime.

#### `engine/expression.ts` — Template Resolution Engine

Resolves `{{...}}` expressions in step inputs at runtime:

**Resolution types**:
- `{{input.amount}}` → workflow input parameter
- `{{steps.fetchData.output.users}}` → output from a previous step
- `{{steps.fetchData.status}}` → status of a previous step

**Key behaviors**:
- **Type preservation**: If the entire string is a single expression (`"{{input.count}}"` where count is `42`), returns the number `42`, not the string `"42"`. This is critical for downstream handlers that expect typed data.
- **String interpolation**: Multiple expressions in one string (`"User {{input.name}} has {{input.count}} items"`) always returns a string.
- **Recursive resolution**: Objects and arrays are walked recursively — expressions anywhere in the tree get resolved.
- **Condition evaluation**: `"{{input.amount}} > 1000"` is parsed and compared. Supports `==`, `!=`, `>`, `<`, `>=`, `<=`.

**Why this matters**: The expression engine makes workflows declarative. No code in workflow definitions — just data with placeholder references that get resolved at runtime.

#### `engine/executor.ts` — Action Registry & Dispatch

Two classes:

**`ActionRegistry`** — a `Map<string, ActionHandler>`:
- `register(handler)` — stores handler by `handler.name`
- `get(name)` — returns handler or throws `ActionNotFoundError`
- `listNames()` — returns registered handler names
- This is the **Strategy pattern**: the registry picks the right handler at runtime based on the step's `action` field.

**`StepExecutor`** — dispatches to handlers and records timing:
- `execute(action, input, ctx)` — looks up handler, calls `handler.execute(input, ctx)`
- `executeAndRecord(action, input, ctx)` — same as execute but wraps with `performance.now()` timing → returns `ExecutionRecord` with `success`, `durationMs`, `result`, `error`

**`ActionHandler` interface**:
```typescript
interface ActionHandler {
  name: string
  execute(input: Record<string, unknown>, ctx: ExecutionContext): Promise<Record<string, unknown>>
}
```

To add a new capability (Slack, Jira, S3, database): implement this interface, call `registry.register(handler)`, reference it in workflow definitions as `action: "slack.notify"`. No engine changes.

#### `engine/learner.ts` — Execution Stats Aggregator

Records every `ExecutionRecord` and computes aggregate stats:

```typescript
interface OperationStats {
  total: number
  successes: number
  failures: number
  avgDurationMs: number
}
```

`statsFor(actionName)` queries the repository and aggregates. This provides operational insights: which actions are slow? Which fail often? In a production system, this feeds back into planning — unreliable actions get flagged, retry policies auto-tune.

### Governance Layer — `src/governance/`

Policy enforcement, approval workflows, and audit trails.

#### `governance/policy-engine.ts` — Data-Driven Rules

`RulePolicyEvaluator` implements `PolicyEvaluator`:
- `addRule(rule)` / `removeRule(name)` — manage rules at runtime
- `evaluatePreStep(run, step)` — checks all rules against the step

**Rule conditions** (simple pattern matching):
- `"action:run_command"` → matches steps with `action === "run_command"`
- `"action:http.request"` → matches HTTP request steps
- `"amount_gt:1000"` → matches steps where `input.amount > 1000`

**Rule effects**:
- `PolicyEffect.Allow` → no-op (null)
- `PolicyEffect.RequireApproval` → return reason string
- `PolicyEffect.Deny` → throw `PolicyViolationError`

**Why data-driven rules?** Rules can be added/removed at runtime without restart. In a production system, rules come from a database or config service. The engine doesn't hardcode what's dangerous — that's a policy decision.

#### `governance/approval-service.ts` — Human-in-the-Loop

When a policy requires approval:
1. Orchestrator creates `ApprovalRequest` and throws `ApprovalRequiredError`
2. Run transitions to `WaitingForApproval`
3. A human (via API) calls `POST /approvals/:id/resolve` with `{ approved: true, user: "alice" }`
4. `ApprovalService.resolve()` updates the request, publishes `ApprovalResolved` event
5. System calls `orchestrator.resume(run)` to continue execution

#### `governance/audit-service.ts` — Immutable Log

`AuditService.log({ actor, action, resourceType, resourceId, detail })`:
- Creates an `AuditEntry` with timestamp
- Appends to `AuditRepository` (append-only — never edited, never deleted)
- `history(resourceType, resourceId)` retrieves entries for a resource

### Adapter Layer — `src/adapters/`

Concrete implementations of port interfaces. All in-memory — swap for production stores.

#### `adapters/memory-repositories.ts` — In-Memory Storage

Five classes, all using `Map` (keyed by ID) or `Array`:

| Class | Port | Storage |
|-------|------|---------|
| `MemoryWorkflowRepository` | `WorkflowRepository` | `Map<id, Workflow>` |
| `MemoryRunRepository` | `RunRepository` | `Map<id, WorkflowRun>` |
| `MemoryApprovalRepository` | `ApprovalRepository` | `Map<id, ApprovalRequest>` |
| `MemoryAuditRepository` | `AuditRepository` | `AuditEntry[]` |
| `MemoryExecutionRecordRepository` | `ExecutionRecordRepository` | `ExecutionRecord[]` |

To switch to PostgreSQL: implement the same 5 interfaces, swap in the `Container`, done.

#### `adapters/memory-event-bus.ts` — In-Process Pub/Sub

`MemoryEventBus` implements `EventBus`:
- `subscribe(type, handler)` → stores handler in `Map<string, handler[]>`
- `publish(event)` → broadcasts to all subscribed handlers for that event type
- `history` → readonly array of all published events (for testing/debugging)
- Error isolation: if a subscriber throws, it logs to console but doesn't break the publisher

#### `adapters/memory-queue.ts` — Synchronous Queue

`MemoryQueue` implements `WorkQueue`:
- `process(handler)` → registers a single handler
- `enqueue(job)` → immediately calls the handler (synchronous)

This is the **scaling boundary**. In production, swap for `RedisQueue` or `SQSQueue` — workers become separate processes consuming from a shared queue. The engine doesn't know or care.

### Actions — `src/actions/builtin.ts`

Five pre-registered action handlers:

| Handler | Name | What It Does |
|---------|------|-------------|
| `HttpRequestAction` | `http.request` | HTTP requests via `fetch()`, configurable method/headers/body/timeout |
| `TransformAction` | `transform` | Field mapping — pick/rename fields from input data |
| `FilterAction` | `filter` | Array filtering with operators (==, !=, >, <, contains) |
| `NoopAction` | `noop` | Pass-through (returns input as output) — useful for testing |
| `LogAction` | `log` | Records messages in an internal `.logs` array |

`builtinActions()` returns all five as an array, used by Container during construction.

### API — `src/api/`

A REST API layer using Fastify v5.

#### `api/container.ts` — The Composition Root

The single place where all dependencies are wired together:

```typescript
class Container {
  // Adapters (swap these to change infrastructure)
  readonly workflowRepo = new MemoryWorkflowRepository()
  readonly runRepo = new MemoryRunRepository()
  // ... all 5 repos + eventBus + queue

  // Engine (depends on adapters via ports)
  readonly actionRegistry = new ActionRegistry()
  readonly executor = new StepExecutor(this.actionRegistry)
  readonly orchestrator = new Orchestrator({ executor, policyEvaluator, learner, runRepo, approvalRepo, eventBus })

  // Governance
  readonly approvalService = new ApprovalService(this.approvalRepo, this.eventBus)
  readonly auditService = new AuditService(this.auditRepo)
}
```

`getContainer()` returns a singleton. `resetContainer()` clears it for test isolation.

**This is the only file that imports adapters.** The engine, governance, and API layers import only ports (interfaces). The container is where concrete implementations get plugged in. This is the **Composition Root** pattern from dependency injection.

#### `api/app.ts` — Fastify Factory

Creates and configures the Fastify instance, registers all route modules, adds a `/health` endpoint.

#### `api/schemas.ts` — Request Validation

Zod schemas for request bodies:
- `CreateWorkflowSchema` — validates WorkflowDefinition shape
- `RunCreateSchema` — validates `{ input: Record<string, unknown> }`
- `ApprovalResolveSchema` — validates `{ approved: boolean, user: string }`

#### `api/routes/*.ts` — HTTP Endpoints

| File | Endpoints |
|------|----------|
| `workflows.ts` | `POST /workflows`, `GET /workflows`, `GET /workflows/:id` |
| `runs.ts` | `POST /workflows/:id/runs`, `GET /workflows/:id/runs`, `GET /workflows/:id/runs/:runId`, `POST /workflows/:id/runs/:runId/resume` |
| `approvals.ts` | `GET /approvals`, `POST /approvals/:id/resolve` |
| `actions.ts` | `GET /actions` |

### Entry Points — `src/lib.ts` and `src/index.ts`

**`lib.ts`** — barrel export for library usage. This is what `@agent001/engine` exposes to the agent package:
```typescript
// Domain
export { createWorkflow, createRun, startPlanning, ... } from "./domain/models.js"
export { WorkflowStatus, RunStatus, StepStatus, ... } from "./domain/enums.js"
export { runStarted, stepCompleted, ... } from "./domain/events.js"
export { PolicyViolationError, ... } from "./domain/errors.js"
// Ports, Adapters, Governance, Learner
```

**`index.ts`** — server entry. Creates the Fastify app, listens on `PORT` (default 3000) and `HOST` (default 0.0.0.0).

---

<a id="integration-boundary"></a>
## How Everything Connects — The Integration Boundary

The agent and engine packages have exactly **one integration point**: the `governance.ts` file in the agent package.

```
packages/agent/src/governance.ts
    │
    │ imports from @agent001/engine:
    │   - Domain types: WorkflowRun, Step, AuditEntry, ExecutionRecord
    │   - Domain functions: createRun, startPlanning, startRunning, completeRun, ...
    │   - Domain enums: StepStatus
    │   - Domain events: runStarted, stepCompleted, ...
    │   - Domain errors: PolicyViolationError
    │   - Governance: AuditService, RulePolicyEvaluator
    │   - Engine: Learner
    │   - Adapters: MemoryRunRepository, MemoryAuditRepository, ...
    │
    │ These go through packages/engine/src/lib.ts (the barrel export)
    │ The engine's package.json: "exports": { ".": "./src/lib.ts" }
```

**The integration is one function signature wide:**

```typescript
// This is the entire boundary between agent tools and engine governance:
tool.execute(args) → Promise<string>
```

Every tool exposes `execute(args): Promise<string>`. The governance wrapper (`governTool()`) wraps this function to add engine behavior before and after. The tool doesn't know it's wrapped. The agent doesn't know its tools are wrapped. The engine doesn't know it's wrapping agent tools.

**This is the Decorator pattern at the architecture level.** It's the reason the integration is clean and the reason you could swap the engine for Temporal:

```
Before: agent → governedTool.execute() → policyCheck → audit → tool.execute() → record → audit
After:  agent → temporalTool.execute()  → workflow → activity(tool.execute()) → record
```

Same function signature. Different substrate. Only `governance.ts` changes.

---

<a id="execution-flow"></a>
## Complete Execution Flow — Governed Mode

Here's every function call, in order, when a user types `"List all .ts files"`:

### 1. Startup (cli.ts)

```
main()
  → createLLMClient()          // reads ANTHROPIC_API_KEY, creates AnthropicClient
  → mode = "governed"
  → goal = "List all .ts files"
  → runGovernedMode(llm, goal)
    → allTools()               // [fetchUrl, readFile, writeFile, listDir, shell, think]
    → createEngineServices()   // creates Memorys: runRepo, auditRepo, recordRepo, eventBus, ...
    → setupDefaultPolicies()   // (hook — no rules by default)
    → runGoverned(goal, llm, tools, services)
```

### 2. Governance Setup (governance.ts)

```
runGoverned():
  → actor = "ai-agent"
  → createRun("agent-session", { goal })         ← WorkflowRun created (Pending)
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

**Where it's applied**: The engine layer imports from `ports/repositories.ts` and `ports/services.ts` — never from `adapters/*`. The `Container` is the only place that creates concrete adapter instances.

**Why it matters**: You can swap `MemoryRunRepository` for `PostgresRunRepository` by changing one line in the Container. The orchestrator, policy engine, audit service — none of them need to change. They only depend on the `RunRepository` interface.

### 2. Dependency Injection (Composition Root)

**What it is**: Dependencies are passed in via constructors, not created internally. A single composition root (`Container`) wires everything together.

**Where it's applied**:
- `Orchestrator` receives `OrchestratorDeps` (executor, policy, learner, repos, eventBus)
- `StepExecutor` receives `ActionRegistry`
- `Learner` receives `ExecutionRecordRepository`
- `AuditService` receives `AuditRepository`
- `ApprovalService` receives `ApprovalRepository` + `EventBus`

**Why it matters**: Every class can be tested in isolation. Pass mocks for every dependency. No global state, no singletons in core logic (the `Container` singleton is only in the API layer).

### 3. Strategy Pattern (Swappable Behaviors)

The same interface with multiple implementations:

| Interface | Implementations |
|-----------|----------------|
| `LLMClient` | `OpenAIClient`, `AnthropicClient` |
| `Tool.execute()` | filesystem, shell, fetch, think (each a different strategy) |
| `ActionHandler` | http.request, transform, filter, noop, log (pluggable) |
| `PolicyEvaluator` | `RulePolicyEvaluator` (could add ML-based, remote API, etc.) |
| `WorkQueue` | `MemoryQueue` (swap for Redis, SQS, RabbitMQ) |
| `RunRepository` | `MemoryRunRepository` (swap for Postgres, DynamoDB) |

**Why it matters**: Every extension point uses the same pattern. To add Anthropic support: implement `LLMClient`. To add a Jira tool: implement `Tool`. To add a Redis queue: implement `WorkQueue`. No core code changes.

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

### 5. Domain-Driven Design (DDD)

**What it is**: Business concepts modeled as entities with behavior, not just data bags.

**Where it's applied**:
- `WorkflowRun` isn't just `{ status: string }`. It has `startPlanning()`, `startRunning()`, `completeRun()` — each verifying the transition is legal.
- `Step` has `startStep()`, `completeStep(output)`, `failStep(error)` — each guarding against illegal states.
- Domain events describe business facts (`RunStarted`, not `StatusChanged`)
- Domain errors describe business problems (`PolicyViolationError`, not `Error("denied")`)

**Why it matters**: Business rules are enforced at the entity level. You can't accidentally put a run into `Completed` from `Pending` — you must go through `Planning → Running → Completed`. Bugs that would otherwise produce corrupt state are caught immediately.

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
- Orchestrator publishes `runStarted`, `stepCompleted`, `runFailed`, etc.
- Governance wrapper publishes the same events for agent tool calls
- `EventBus.subscribe("run.completed", handler)` — subscribers are decoupled from publishers

**Why it matters**: Adding monitoring, webhooks, or analytics doesn't require changing the orchestrator or governance layer. Subscribe to events from outside.

### 8. Interpreter Pattern (Workflow Definitions)

**What it is**: A mini-language (the workflow definition JSON) is interpreted at runtime.

**Where it's applied**:
- `WorkflowDefinition` is the "program"
- The expression engine (`{{input.x}}`, `{{steps.prev.output.y}}`) is a mini-language
- The orchestrator is the interpreter — reads the definition, evaluates expressions, dispatches to handlers

**Why it matters**: Business logic lives in workflow definitions (data), not in imperative code. To change what a workflow does, change the definition — don't write new code. This is the same concept as SQL (data language interpreted by an engine) or Terraform (infrastructure language interpreted by providers).

### 9. Repository Pattern (Persistent Collections)

**What it is**: Abstract collection interfaces hiding storage details.

**Where it's applied**: All 5 repository interfaces in `ports/repositories.ts`. Code works with `runRepo.save(run)` and `runRepo.get(id)` — never with `Map.set()` or `db.query()`.

**Why it matters**: Storage is a detail. The domain doesn't know if data is in a Map, PostgreSQL, or DynamoDB. Switching databases requires implementing 5 interfaces — no domain/engine changes.

### 10. Factory Pattern (Entity Construction)

**What it is**: Dedicated functions for creating complex objects with validation.

**Where it's applied**:
- `createWorkflow(definition)` → generates ID, sets status to Draft, attaches definition
- `createRun(workflowId, input)` → generates ID, sets status to Pending, initializes timestamps
- `createApprovalRequest(params)` → generates ID, sets status to Pending
- `createAuditEntry(params)` → generates ID, sets timestamp

**Why it matters**: Constructor validation in one place. No scattered `{ id: randomUUID(), status: "Pending", ... }` throughout the codebase.

---

<a id="swapping"></a>
## Why This Architecture Makes Swapping Easy

### Example: Swapping the Engine for Temporal

[Temporal](https://temporal.io) is a workflow orchestration platform. It provides exactly what our engine provides — run tracking, retries, state persistence, audit — but as an external service instead of in-process code.

**What would change:**

| Component | Current | With Temporal | Amount of Change |
|-----------|---------|---------------|-----------------|
| `governance.ts` | Wraps tools with in-memory engine | Wraps tools as Temporal activities | **Rewrite this file** |
| `agent.ts` | Unchanged | Unchanged | **Zero** |
| `cli.ts` | Unchanged | Unchanged | **Zero** |
| `types.ts` | Unchanged | Unchanged | **Zero** |
| All tools | Unchanged | Unchanged | **Zero** |
| LLM clients | Unchanged | Unchanged | **Zero** |

**Why it's one file**: The integration boundary is one function signature: `tool.execute(args) → Promise<string>`. In our engine, that function is wrapped with in-process policy checks and audit. In Temporal, that function becomes a Temporal _activity_ inside a Temporal _workflow_. The agent still calls `tool.execute(args)` either way.

```typescript
// Current: in-process governance
async execute(args) {
  await policyCheck(step)
  await auditLog("invoked")
  const result = await originalTool.execute(args)
  await auditLog("completed")
  return result
}

// Temporal: the same wrapping, but in a workflow
async execute(args) {
  return temporal.executeWorkflow("toolExecution", {
    args: { tool: this.name, args },
    taskQueue: "agent-tools",
  })
}
// The workflow wraps the activity with retries, timeout, audit via Temporal's built-in features
```

### Example: Swapping Memory Repos for PostgreSQL

```typescript
// container.ts — before:
readonly runRepo = new MemoryRunRepository()

// container.ts — after:
readonly runRepo = new PostgresRunRepository(pool)
```

`PostgresRunRepository` implements `RunRepository` (same `save()`, `get()`, `listByWorkflow()`). The orchestrator, governance, API — none of them change. They import `RunRepository` (the interface), not `MemoryRunRepository` (the implementation).

### Why This Works

It's not magic — it's the **dependency inversion principle** consistently applied:

1. **Core logic depends on abstractions** (ports/interfaces)
2. **Details depend on abstractions** (adapters implement interfaces)
3. **Composition happens once** (Container or governance.ts)
4. **Boundaries are narrow** (one function signature, one interface)

When every boundary is an interface, swapping an implementation is always a localized change. The rest of the system doesn't know and doesn't care.

---

<a id="testing-strategy"></a>
## Testing Strategy

### Agent Tests (18 tests)

**No API keys needed.** Tests use a mock `scriptedLLM()` that returns pre-programmed responses:

```typescript
function scriptedLLM(responses: LLMResponse[]): LLMClient {
  let i = 0
  return { chat: async () => responses[i++] }
}
```

Combined with `echoTool()` (returns its input) and `failingTool()` (always throws), this tests the full governance lifecycle:

| Category | Tests | What's Verified |
|----------|-------|----------------|
| Run tracking | 4 | WorkflowRun created, steps tracked, run completes/fails, persisted to repo |
| Audit trail | 4 | agent.started/completed logged, tool.invoked/completed per call, failures logged, actor recorded |
| Policies | 3 | Deny blocks tool, RequireApproval blocks tool, no policy = allow |
| Execution records | 3 | Metrics recorded in learner, failures tracked, per-tool stats returned |
| Domain events | 4 | run.started/completed emitted, step.started/completed per tool, step.failed on error, run.failed on agent failure |

### Engine Tests (71 tests across 7 files)

| File | Tests | What's Covered |
|------|-------|---------------|
| `models.test.ts` | 12 | State machine transitions for Workflow, WorkflowRun, Step, ApprovalRequest |
| `expression.test.ts` | 16 | Input/step/status reference resolution, type preservation, interpolation, condition evaluation |
| `planner.test.ts` | 7 | Topological sort, dependency ordering, cycle detection, unknown dependency detection |
| `executor.test.ts` | 8 | ActionRegistry CRUD, StepExecutor dispatch, timing recording |
| `orchestrator.test.ts` | varies | Full execution workflows, conditional steps, error strategies, policy pauses |
| `governance.test.ts` | 17 | Policy evaluation, approval lifecycle, audit service |
| `api.test.ts` | 15 | HTTP endpoints via Fastify `inject()` (no server start) |

**Testing patterns**:
- Engine tests use `buildTestDeps()` from `helpers.ts` — pre-wired in-memory adapters + mock action handlers
- API tests use `resetContainer()` for isolation between tests
- Domain tests are pure unit tests — no mocking needed, just call functions and assert state
- Fastify's `inject()` method sends HTTP requests without starting a server

---

<a id="dependency-flow"></a>
## Dependency Flow

```
API Layer (Fastify routes + Zod validation)
    │  depends on
    ▼
DI Container (wires adapters ↔ engine ↔ governance)
    │  constructs
    ▼
Engine + Governance (pure logic against port interfaces)
    │  depends on
    ▼
Ports (interfaces only — no implementations)
    ▲  implements
    │
Adapters (concrete: Memory*, swap for Postgres/Redis/SQS)
```

```
Agent CLI (cli.ts — entry point)
    │  creates
    ▼
Governance (governance.ts — wraps tools with engine substrate)
    │  creates                    │  imports from
    ▼                             ▼
Agent (agent.ts — LLM loop)    @agent001/engine (via lib.ts barrel)
    │  calls                      │  provides
    ▼                             ▼
Governed Tools                  Domain types, services, adapters
    │  wraps
    ▼
Raw Tools (filesystem, shell, fetch, think)
```

**The dependency rule**: inner layers never depend on outer layers. Domain has zero imports from engine, governance, adapters, or API. The engine depends only on domain + ports. Adapters depend on domain + ports. The API depends on everything but is a thin shell. The agent depends on the engine only through `lib.ts` exports.
