# Design Decisions & Core Patterns

The reasoning behind every structural choice in agent001 — why certain things are classes and others are functions, why `executeRun` is structured the way it is, and the principles that hold everything together.

---

## The Domain Layer — What Goes in `engine/` and Why

The `engine/` directory inside `packages/agent/src/` is the **domain layer**. It contains the business concepts of the system — what an agent run *is*, what a step *is*, what events happen, what rules exist — without any knowledge of how they're stored, displayed, or transported.

Here's the full inventory:

```
engine/
├── enums.ts         →  RunStatus, StepStatus, PolicyEffect
├── models.ts        →  AgentRun, Step, AuditEntry, PolicyRule, ExecutionRecord
├── events.ts        →  RunStarted, StepCompleted, ApprovalRequired, etc.
├── errors.ts        →  InvalidTransitionError, PolicyViolationError
├── interfaces.ts    →  RunRepository, AuditRepository, PolicyEvaluator, EventBus
├── policy.ts        →  RulePolicyEvaluator (implements PolicyEvaluator)
├── audit.ts         →  AuditService (uses AuditRepository)
├── learner.ts       →  Learner (uses ExecutionRecordRepository)
├── memory.ts        →  MemoryRunRepository, MemoryAuditRepository, MemoryEventBus
└── index.ts         →  Barrel export
```

### The litmus test: "Would this concept exist on a whiteboard?"

If you were explaining agent001 to someone with no code — just a whiteboard — you'd draw:

- A **run** that goes through states (pending → planning → running → completed/failed)
- **Steps** inside a run (each tool call is a step)
- **Events** that fire when things happen (run started, step failed)
- **Policy rules** that block or allow tool calls
- An **audit trail** of everything that happened

These are the **nouns and verbs of the domain**. They'd exist regardless of whether you store them in SQLite, Postgres, Redis, or plain files. They'd exist if the UI were a CLI, a web app, or a Slack bot.

That's the test: if it would exist on the whiteboard, it's domain. If it only exists because of a technology choice (SQLite, WebSocket, HTTP), it's infrastructure.

### Why these aren't services

Look at `AgentRun`:

```typescript
export interface AgentRun {
  id: string
  status: RunStatus
  steps: Step[]
  createdAt: Date
  completedAt: Date | null
}

export function startPlanning(run: AgentRun): void {
  transitionRun(run, RunStatus.Planning)  // throws if transition is illegal
}
```

This is **data that knows its own rules**. A run knows which status transitions are legal. You can't go from `Pending` to `Completed` — you must go through `Planning` → `Running` → `Completed`. The transition table enforces this.

Why isn't this a `RunService` class? Because there's no service *logic* here. There's no database call, no network request, no side effect. It's pure state mutation with validation. A service would be overkill — you'd be wrapping a 3-line function in a class just to have a class.

Compare with `AuditService`:

```typescript
export class AuditService {
  constructor(private readonly repo: AuditRepository) {}

  async log(params: { actor, action, resourceType, resourceId, detail? }): Promise<AuditEntry> {
    const entry = createAuditEntry(params)  // ← domain: create the entry
    await this.repo.append(entry)           // ← infrastructure: persist it
    return entry
  }
}
```

This **is** a service because it coordinates between domain (create an audit entry) and infrastructure (save it to a repository). The repository is injected — the service doesn't know if it's in-memory, SQLite, or an API. The service earns its existence by bridging the two.

### The hierarchy: model → service → infrastructure

| Layer | What lives here | Knows about... | Example |
|---|---|---|---|
| **Models** (`models.ts`) | Data shapes, state transitions, factory functions | Nothing but itself and enums | `AgentRun`, `createRun()`, `completeRun()` |
| **Events** (`events.ts`) | Typed facts about what happened | Models (references IDs) | `runStarted(runId)`, `stepFailed(runId, stepId, reason)` |
| **Interfaces** (`interfaces.ts`) | Contracts for persistence and evaluation | Models, events | `RunRepository`, `PolicyEvaluator`, `EventBus` |
| **Services** (`audit.ts`, `policy.ts`, `learner.ts`) | Coordination logic | Models + interfaces (injected) | `AuditService.log()`, `RulePolicyEvaluator.evaluatePreStep()` |
| **In-memory impls** (`memory.ts`) | Test/runtime implementations | Interfaces, models | `MemoryRunRepository`, `MemoryEventBus` |

Models import nothing but enums. Services import models and interfaces. In-memory implementations import interfaces. **Dependencies point inward** — infrastructure depends on domain, never the reverse.

### When to use each pattern

**Make it a plain interface + free functions when:**
- It's data the system reasons about (`AgentRun`, `Step`, `AuditEntry`)
- It has state transitions with rules (`Pending → Running → Completed`)
- It needs to be serialized/deserialized freely (`JSON.stringify`)
- There are no side effects — just validation and mutation

**Make it a service class when:**
- It coordinates between domain objects and infrastructure (`AuditService` creates an entry *and* persists it)
- It has a dependency that should be injectable (a repository, an API client)
- It bridges two concerns that shouldn't know about each other

**Make it an enum when:**
- It's a finite, known set of values (`RunStatus`, `PolicyEffect`)
- Other code branches on it (`if (status === RunStatus.Running)`)
- It appears in transition tables and pattern matching

**Make it a domain event when:**
- Something happened that other parts of the system might care about
- You want to decouple the producer from the consumers
- The event is a fact, not a command (`runCompleted` not `completeRun`)

**Make it an interface (contract) when:**
- There will be multiple implementations (`RunRepository` → Memory, SQLite)
- You want to test with fakes
- The caller shouldn't know how the work is done

### What about `PolicyEvaluator` — why is it in the domain?

`RulePolicyEvaluator` is a class in `policy.ts`. It has state (a list of rules) and behavior (evaluate a step against rules). But it has **zero infrastructure deps** — no database, no network. It evaluates in-memory rules against in-memory data.

This is domain logic: "given these rules and this step, is the step allowed?" The decision is a business concept. The rules themselves are persisted in SQLite by the server, loaded at run start, and injected via `addRule()`. The evaluator doesn't know where the rules came from.

If the evaluator needed to fetch rules from a database on each call, it would need a repository injected and would become an infrastructure-touching service. But it doesn't — rules are loaded once, evaluation is pure logic.

### Practical example: designing a new feature

Say you're adding **cost budgets** — a run should fail if it exceeds $5 in LLM costs.

1. **Domain model:** Add `budget: number | null` to `AgentRun`. Add `BudgetExceededError` to `errors.ts`. → This is the concept.
2. **Domain event:** Add `budgetExceeded(runId, spent, limit)` to `events.ts`. → This is the fact.
3. **Service (maybe):** If the check requires looking up pricing from an external API, create a `BudgetService` that takes a pricing provider interface. → This bridges domain and infrastructure.
4. **No service (simpler):** If you just compare `agent.usage.totalTokens * pricePerToken > budget`, that's a 3-line check in `governTool` or `onStep`. No service needed. → Don't add a class for one comparison.

The question is always: "does this concept require coordinating with something external?" If yes → service. If no → model/function.

---

## The Fundamental Boundary

```
packages/agent/    →  Pure runtime. Zero infrastructure deps.
packages/server/   →  All infrastructure. SQLite, HTTP, WebSocket.
```

The agent package has no idea it's running inside a server. No database imports, no HTTP, no filesystem assumptions. It defines the vocabulary (`types.ts`), the loop (`agent.ts`), and the domain model (`engine/`). This boundary means the agent loop can run in a test, in a CLI, in a browser, or inside a completely different server — without changing a line.

---

## Where Orchestrator Meets Agent

The boundary is one line in `executeRun()`:

```typescript
const agent = new Agent(this.llm, allTools, { ... })
const answer = await agent.run(goal)
```

Everything **above** this line is orchestrator work: acquire a queue slot, load policies, wrap tools with governance, build the system prompt, wire event broadcasting.

Everything **below** is cleanup: persist the result, release the slot, emit notifications.

The `Agent` class knows nothing about the orchestrator. It receives an LLM client, a list of tools, and a config. It returns an answer string. The orchestrator owns **lifecycle** (start → checkpoint → resume → cancel → complete). The agent owns **reasoning** (LLM → tool calls → LLM → answer).

---

## Why Agent Is a Class

```typescript
export class Agent {
  readonly usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  llmCalls = 0

  async run(goal: string, resume?: { messages, iteration }): Promise<string>
}
```

The agent accumulates state during its run: token usage, LLM call count. These are **per-instance counters** that grow as the loop iterates. A class scopes mutable state to a single run naturally. After `agent.run()` returns, the orchestrator reads `agent.usage` and `agent.llmCalls` to persist usage data.

If this were a plain function, you'd return these alongside the answer (a tuple or result object) — less ergonomic and harder to extend.

**Rule of thumb:** use a class when there's mutable state that outlives a single function call.

---

## Why Domain Models Use Free Functions, Not Methods

```typescript
// models.ts — the run is plain data (an interface, not a class)
export interface AgentRun {
  id: string
  status: RunStatus
  steps: Step[]
  ...
}

// Transitions are free functions that mutate the data
export function startPlanning(run: AgentRun): void { ... }
export function completeRun(run: AgentRun): void { ... }
export function failRun(run: AgentRun): void { ... }
```

`AgentRun` and `Step` are interfaces with guarded transitions, not classes. Three reasons:

1. **Serialization.** Runs get `JSON.stringify()`'d to SQLite constantly. Interfaces serialize naturally. Classes need custom serializers, and you lose the prototype chain on deserialization.

2. **Testability.** You construct a run as a plain object literal in tests. No constructor args, no `new`, no ceremony.

3. **Separation.** The data shape is defined once. The transition logic is a set of pure functions that enforce the state machine (`Pending → Planning → Running → Completed`). Calling `completeRun()` on a `Pending` run throws `InvalidTransitionError`. This is a lightweight state machine without a framework.

---

## Why executeRun Calls So Many Module-Level Functions

Look at `executeRun()`:

```typescript
const run = createRun("agent-session", { goal })
startPlanning(run)
startRunning(run, [])
const governedTools = tools.map(t => governTool(t, services, state))
const delegateTools = createDelegateTools(delegateCtx)
const busTools = createBusTools(bus, runId, agentName)
// ...
completeRun(run)
await services.eventBus.publish(runCompleted(run.id))
```

This method pulls in functions from across the agent package. That's intentional — `executeRun` is the **composition root**. It's the one place where all the pieces come together. Each piece is independently testable:

- `createRun()` / `startPlanning()` / `completeRun()` — tested as state transitions
- `governTool()` — tested as a wrapper (policy check → execute → audit)
- `createDelegateTools()` — tested as a factory returning tools
- `createBusTools()` — tested as a factory for messaging tools

The orchestrator doesn't own any of this logic. It wires them together in the right order. That's why `executeRun` reads like a procedural script — **it is one**. It's the sequence: create run → plan it → govern the tools → build the agent → run it → persist the result.

Other methods like `cancelRun()` or `resumeRun()` are simpler because they don't need this full composition — they operate on already-running or already-persisted state.

---

## Why Governance Is a Wrapper Function, Not a Base Class

```typescript
export function governTool(tool: Tool, services: EngineServices, state: RunState): Tool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    async execute(args) {
      // 1. Policy check (allow / deny / require approval)
      // 2. Create step + start tracking
      // 3. Audit: tool.invoked
      // 4. Execute with timeout + retry
      // 5. Record execution metrics
      // 6. Emit domain events (stepStarted, stepCompleted, stepFailed)
      // 7. Audit: tool.completed or tool.failed
      return result
    },
  }
}
```

`governTool` takes a `Tool` in and returns a new `Tool` out — same shape, wrapped `execute()`. This is the decorator pattern via function composition.

Why not a `GovernedTool` base class or a mixin?

- **Tools don't know they're governed.** `read_file` is just a function that reads a file. It doesn't import governance, audit, or policy modules. One job.
- **Governance is orthogonal.** Run tools ungoverned in tests, fully governed in production, or with custom governance in future scenarios.
- **Composable.** Stack additional wrappers (rate limiting, caching) the same way without touching the tool or the governance layer.

A base class would couple every tool to the governance system. Tools should be dumb; the orchestration layer makes them smart.

---

## Why EngineServices Are In-Memory Per-Run

```typescript
export function createEngineServices(): EngineServices {
  return {
    runRepo: new MemoryRunRepository(),
    auditService: new AuditService(new MemoryAuditRepository()),
    policyEvaluator: new RulePolicyEvaluator(),
    learner: new Learner(new MemoryExecutionRecordRepository()),
    eventBus: new MemoryEventBus(),
  }
}
```

Every run gets fresh services. Not shared, not pooled.

1. **No cross-contamination.** Run A's event subscribers don't fire for Run B's events. Run A's audit log doesn't mix with Run B's.
2. **Clean lifecycle.** When a run ends, its services are GC'd. No cleanup code, no "reset" methods.
3. **Concurrent safety.** Multiple runs execute simultaneously. Shared mutable state would need synchronization. Per-run instances need none.

Engine services are the **in-flight working memory** of a single run. The orchestrator owns durable persistence (SQLite). After the run finishes, the orchestrator extracts what it needs (`auditService.history()`, `agent.usage`) and writes it to the database.

---

## Why RunQueue Is Not Dependency-Injected

```typescript
constructor(config: OrchestratorConfig) {
  this.llm = config.llm                           // ← injected
  this.messageRouter = config.messageRouter ?? null // ← injected
  this.workspace = config.workspace ?? null         // ← injected
  this.queue = new RunQueue()                       // ← created internally
}
```

Three things are injected. One is not.

| Dependency | Injected? | Why |
|---|---|---|
| `LLMClient` | Yes | Swappable — OpenAI, Anthropic, mock for tests |
| `MessageRouter` | Yes | Optional, wired after construction, not always present |
| `workspace` | Yes | External config from env or user |
| `RunQueue` | No | Internal detail. One implementation. Tightly coupled to `executeRun`/`cancelRun` lifecycle |

The queue is to the orchestrator what `activeRuns: Map` is — internal state management. You wouldn't inject the Map. The queue's only configuration (`MAX_CONCURRENT_RUNS`) reads from an environment variable internally.

If there's ever a second implementation (Redis-backed for multi-process), inject it then. Until then, it's premature abstraction.

---

## The Tool Contract

```typescript
export interface Tool {
  name: string
  description: string
  parameters: Record<string, unknown>  // JSON Schema
  execute(args: Record<string, unknown>): Promise<string>
}
```

Every tool returns a `string`. Not typed results, not objects. Because:

1. **LLM compatibility.** Tool results go into the message history as `{ role: "tool", content: string }`. The LLM reads strings.
2. **Universal interface.** Whether a tool reads a file, runs a command, or queries a database — the result is text the LLM interprets.
3. **Simplicity.** No serialization layer, no result types to maintain.

Tools are stateless functions. They don't hold references to the run, the orchestrator, or each other. The only shared state is a global workspace root (`setBasePath()`) set once at startup.

---

## Why Delegate Tools Are Just Tools

```typescript
export function createDelegateTools(ctx: DelegateContext): Tool[]
```

Delegation is implemented as regular tools. The agent doesn't know `delegate` spawns child agents — it sees `name`, `description`, `parameters`, `execute()`, like any other tool. The LLM decides to delegate based on the tool's description, not special-cased logic.

The factory pattern exists because delegate tools need **run-specific context**: the LLM client, governed tools, current depth, abort signal, queue slot acquirer, bus tools. The orchestrator assembles this context and passes it to the factory.

Recursion is natural: each child agent receives delegate tools at `depth + 1`. When `depth >= maxDepth`, the factory returns an empty array — the child simply doesn't have delegation capability. No special depth check in the agent loop.

---

## The AgentBus — Scoped Communication

```typescript
class AgentBus {
  publish(topic, fromRunId, fromAgent, content): AgentMessage
  subscribe(topic, handler): () => void
  history(topic?): AgentMessage[]
  dispose(): void
}
```

One bus per run tree. The parent orchestrator creates it; all delegates in that tree share it via `extraChildTools`. This scoping means:

- Siblings communicate (researcher publishes findings, implementer reads them)
- Parent broadcasts context to all children
- Run A's messages are invisible to Run B

Agents interact with the bus through tools (`send_message`, `check_messages`) — not by calling `bus.publish()` directly. Same principle: **tools are the only interface** the LLM has.

---

## Checkpointing & Resume

```typescript
onStep: (messages, iteration) => {
  db.saveCheckpoint({ run_id: runId, messages: JSON.stringify(messages), iteration })
}
```

After every tool execution round, the full message history and iteration counter are saved to SQLite. If the process crashes:

1. `recoverStaleRuns()` finds runs with status `running`
2. Marks them as failed
3. Calls `resumeRun()` → loads checkpoint → creates new run with `parent_run_id`
4. Passes `{ messages, iteration }` to the agent — the loop continues from where it stopped

The resume isn't deterministic — the LLM might choose different tool calls. But the full conversation history is preserved, so the agent has context of what it already did.

---

## Event Flow — Why the Agent Doesn't Emit Events

```
Agent calls tool.execute(args)
  → governTool wrapper intercepts
    → emits stepStarted / stepCompleted / stepFailed
      → orchestrator's wireEventBroadcasting() catches events
        → broadcast() to WebSocket clients
        → saveTrace() to SQLite
        → saveLog() to structured log
```

The agent loop doesn't emit events. The governance wrapper does. The orchestrator subscribes and routes events to persistence and WebSocket. The UI subscribes to WebSocket and renders live.

This means adding a new observer (Slack notifications, metrics exporter) is one `services.eventBus.subscribe()` call. No changes to the agent or governance layer.

---

## Callbacks Bridge the Package Gap

```typescript
// orchestrator passes callbacks DOWN to the agent package
const delegateCtx: DelegateContext = {
  onChildTrace: (entry) => { this.saveTrace(runId, entry) },
  onChildUsage: (usage) => { broadcast({ type: "usage.updated", ... }) },
}

const agent = new Agent(this.llm, allTools, {
  onStep: (messages, iteration) => { db.saveCheckpoint(...) },
})
```

The agent package can't import the server package (that would be a circular dependency and would break the "pure runtime" principle). So the server injects behavior via callbacks:

- `onStep` — the orchestrator saves checkpoints and broadcasts thinking
- `onChildTrace` — delegate events get persisted and broadcast
- `onChildUsage` — child token usage gets rolled up to the parent

This is dependency inversion without interfaces — **the agent defines what it needs (callback signatures), the orchestrator provides the implementation**.

---

## In-Memory Queue Instead of Redis

The system is a single-process Node.js app with SQLite. Redis would add:

- External process to install, configure, monitor
- Network hop for every queue operation
- Connection management and reconnection logic
- Docker/infra complexity for what is currently `npm start`

The queue's job is narrow: **throttle concurrent LLM calls** (default 5). It's a semaphore with priority ordering (critical > high > normal > low). Durability comes from SQLite checkpoints + `recoverStaleRuns()`.

The seams exist for scaling: `RunQueue` is a class, `acquire()/release()` is the contract. Swapping to Redis means implementing the same interface with a different backing store.

---

## Why Compensation Log, Not Sagas

The rollback system in `effects.ts` uses a **compensation log** pattern rather than the saga pattern commonly used in distributed systems.

**What's a compensation log?** Like a database write-ahead log (WAL). Every side-effect is recorded _as it happens_, with a pre-snapshot. To undo, walk the log in reverse and apply compensations.

**Why not sagas?** Sagas solve a different problem — coordinating rollback across multiple independent services. Our system is a single process with a single SQLite database. The complexity of saga orchestration (compensating transactions, idempotency tokens, failure modes for each participant) is unnecessary when everything runs in one process.

**How it handles mid-run failure:** If the agent fails at step 23, the first 23 effects and their snapshots are already in SQLite (they were written as each tool executed, not batched). The user can rollback those 23 effects via the UI — or inspect them first and decide not to.

**Why not auto-rollback on failure?** The user may want to keep partial results. A run that completes 23 out of 25 file writes might have 23 perfectly good files. Auto-rollback would destroy them. Instead, the system makes rollback _available_ (prominently, in 5 UI surfaces) and lets the user decide.

**Why two-phase?** The preview/confirm approach (validate ALL → apply ALL) prevents partial rollback. If one file was modified externally since the agent wrote it, the rollback would produce an inconsistent state. The preview catches this — the user sees "this file will fail" and can abort the entire operation.

---

## Why Docker Sandbox Instead of Process-Level Isolation

Shell commands from an AI agent are inherently dangerous. Two constraints drove the Docker sandbox choice:

1. **Process-level sandboxing is platform-dependent** — `seccomp`, `landlock`, `pledge/unveil` depend on the OS. Docker provides consistent isolation across macOS and Linux.
2. **File system isolation is the critical requirement** — the agent must be able to write files in its workspace but must not be able to read/modify system files. Docker's volume mounting (`-v workspace:/workspace:rw`) solves this cleanly.

**The fallback matters**: Not every development machine has Docker installed. The sandbox supports `"host"` mode (no Docker, direct execution) for development setups. The `"docker"` mode tries Docker first and falls back to host if unavailable. Only `"all"` mode requires Docker.

**Why not Firecracker/gVisor?** Overkill for development-time agent execution. Docker with `--cap-drop=ALL --read-only --security-opt=no-new-privileges` provides sufficient isolation. The security posture can be upgraded by swapping the container runtime — the interface (`exec()` → `SandboxResult`) stays the same.

---

## Why 4-Layer Path Validation Instead of `realpath()`

The filesystem tools (`read_file`, `write_file`, `list_directory`) use a 4-layer validation pipeline instead of a simple `realpath()` + prefix check:

1. **Input sanitization** — reject null bytes, normalize path separators. Catches the most obvious attacks.
2. **Traversal detection** — resolve the path against the workspace root, confirm it stays inside. Catches `../../etc/passwd`.
3. **Symlink resolution** — `realpath()` follows symlinks to their final target, then checks the target is inside the workspace. Catches `ln -s /etc/passwd ./safe-looking-name`.
4. **Root check** — final verification the fully resolved path starts with the workspace root. Defense in depth.

A single `realpath()` + prefix check would miss TOCTOU races (file created between check and access) and wouldn't catch null byte injection. The layered approach provides defense in depth — each layer catches attacks the others might miss.

---

## Why 2-Tier Shell Deny List

The `shellTool` maintains two separate deny lists: `CONTAINER_RULES` (for Docker sandbox) and `HOST_RULES` (for direct host execution).

**Host rules are strict**: Block `rm -rf /`, `curl | sh`, `chmod -R 777`, etc. The agent is running with the user's full permissions on the host.

**Container rules are lenient**: Inside Docker with `--cap-drop=ALL`, `--read-only`, and `--network=none`, most dangerous commands are already neutralized by the container runtime. The deny list is shorter because the container provides the safety boundary.

This avoids over-restricting the agent in sandbox mode (where Docker already provides isolation) while maintaining safety on the host (where the agent has real permissions).

---

## Why Budget-Weighted Memory Retrieval

The memory system (`memory.ts`) allocates token budget across tiers using fixed percentages: Working 34%, Episodic 22%, Semantic 44%.

**Why not retrieve everything?** LLM context windows are finite. Injecting 50 irrelevant memories wastes tokens and degrades reasoning quality. Budget allocation ensures a balanced mix: recent context (working), moderate-age summaries (episodic), and long-lived knowledge (semantic).

**Why fixed percentages?** Adaptive allocation (e.g., "use more semantic if episodic is empty") adds complexity without clear benefit. The fixed split is predictable and debuggable. The percentages were tuned empirically — semantic gets the most because consolidated knowledge is highest-signal.

**Why FTS5 + optional vectors?** FTS5 (BM25 keyword matching) works without any external services — pure SQLite. Vector embeddings (via Ollama) provide semantic similarity ("similar meaning, different words") but require a running embedding service. Making vectors optional keeps the system self-contained while allowing upgrades.

---

## Why Trajectory Replay Uses Event Sequences, Not State Snapshots

The trajectory system (`trajectory.ts`) represents runs as ordered event sequences rather than state snapshots at each point.

**Event sequences are smaller** — a single event like `{ kind: "tool-call", name: "write_file", args: {...} }` is much smaller than a full state snapshot of the agent's message history + run state + step state.

**Mutations are natural** — dropping, replacing, or injecting events into a sequence is straightforward array manipulation. Doing the equivalent on state snapshots would require computing state diffs.

**Validation is a state machine walk** — given a sequence of events, `validateTransitions()` walks through them and checks each transition is legal. This is the standard approach for replay validation (same pattern as event sourcing replay).

**The trade-off** — you can't jump to an arbitrary point in the trajectory without replaying from the start. For our use case (debugging agent runs, which are typically 1-30 iterations), this is acceptable.

---

## Pattern Summary

| Pattern | Where Used | Reasoning |
|---|---|---|
| **Class with mutable state** | `Agent`, `AgentOrchestrator`, `RunQueue`, `AgentBus`, `DockerSandbox` | State scoped to instance lifetime |
| **Interface + free functions** | `AgentRun`, `Step` + `createRun()`, `completeRun()` | Serializable data, testable transitions, no constructor |
| **Factory function** | `createDelegateTools()`, `createBusTools()`, `createEngineServices()` | Context-dependent construction |
| **Decorator/wrapper function** | `governTool()`, `wrapWithEffects()` | Cross-cutting concerns without modifying the original |
| **Composition root** | `executeRun()` | One place assembles everything; pieces tested independently |
| **Callbacks for DI** | `onStep`, `onChildTrace`, `onChildUsage` | Bridge packages without circular imports |
| **Compensation log** | `effects.ts` (recordEffect → rollbackRun) | Incremental side-effect capture with atomic reversal |
| **Two-phase commit** | `previewRollback()` → `rollbackRun()` | Validate all before changing any — prevents partial rollback |
| **Module-level singleton** | `tools.ts` tool registry | Stateless catalog, set once |
| **Internal instantiation** | `RunQueue`, `activeRuns`, `DockerSandbox` | Implementation detail, one variant |
| **Constructor injection** | `LLMClient`, `MessageRouter` | Multiple implementations or test doubles |
| **Budget-weighted retrieval** | `memory.ts` (working 34%, episodic 22%, semantic 44%) | Balanced context injection under token constraints |
| **Event sequence over snapshots** | `trajectory.ts` (replay, mutations, validation) | Compact, natural mutation support, state machine validation |
