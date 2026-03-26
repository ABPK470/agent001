# Architecture & Design Patterns

## Overview

agent001 is a **generic, declarative workflow engine** built with a hexagonal (ports & adapters) architecture. The core idea: business logic lives in **workflow definitions** (JSON data) and **action handlers** (plugins), never in the orchestrator itself. The engine interprets definitions, resolves expressions, enforces policies, and dispatches to handlers — it can execute any workflow without code changes.

```
                    ┌──────────────────────────┐
                    │     API (Fastify)         │
                    │  HTTP routes + Zod valid. │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │      DI Container         │
                    │  Wires the object graph   │
                    └────────────┬─────────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         │                       │                       │
┌────────▼────────┐   ┌─────────▼─────────┐   ┌─────────▼────────┐
│     Engine       │   │   Governance      │   │  Action Handlers │
│ Orchestrator     │   │ Policies          │   │ http.request     │
│ Planner (DAG)    │   │ Approvals         │   │ transform        │
│ Expression Eng.  │   │ Audit             │   │ filter, log, ... │
│ Executor         │   │                   │   │ + any custom     │
│ Learner          │   │                   │   │                  │
└────────┬─────────┘   └────────┬──────────┘   └──────────────────┘
         │                      │
         └──────────┬───────────┘
                    │
         ┌──────────▼──────────┐
         │      Ports          │
         │ (interfaces only)   │
         └──────────┬──────────┘
                    │
         ┌──────────▼──────────┐
         │     Adapters        │
         │ In-memory repos     │
         │ Memory event bus    │
         │ Memory work queue   │
         │ (swap for Postgres, │
         │  Redis, SQS, etc.)  │
         └─────────────────────┘
```

---

## Layered Architecture

### 1. Domain Layer — `src/domain/`

The innermost layer. Pure TypeScript with **zero infrastructure dependencies**. Contains all business entities, state machines, events, and error types.

**Files:**

| File | Purpose |
|------|---------|
| `enums.ts` | Value types — `WorkflowStatus`, `RunStatus`, `StepStatus`, `ApprovalStatus`, `PolicyEffect`, `Severity` |
| `models.ts` | Domain entities (`Workflow`, `WorkflowRun`, `Step`, `ApprovalRequest`, `PolicyRule`, `AuditEntry`, `ExecutionRecord`) with guarded state transition functions |
| `workflow-schema.ts` | Declarative schema — `WorkflowDefinition`, `StepDefinition`, `ParameterDef`, `RetryPolicy` |
| `events.ts` | Domain events — `RunStarted`, `StepCompleted`, `ApprovalRequested`, etc. |
| `errors.ts` | Domain-specific error hierarchy — `DomainError` base with `InvalidTransitionError`, `PolicyViolationError`, `ExpressionError`, etc. |

### 2. Port Layer — `src/ports/`

Interfaces (contracts) that the engine depends on. No implementations here — just shapes.

| File | Interfaces |
|------|-----------|
| `repositories.ts` | `WorkflowRepository`, `RunRepository`, `ApprovalRepository`, `AuditRepository`, `ExecutionRecordRepository` |
| `services.ts` | `PolicyEvaluator`, `EventBus`, `WorkQueue` (+ `StepJob`) |

### 3. Engine Layer — `src/engine/`

The generic execution engine. Interprets workflow definitions, resolves expressions, dispatches to action handlers, records results. Knows nothing about specific business logic.

| File | Role |
|------|------|
| `orchestrator.ts` | Core execution loop — plan → condition → expression → policy → execute → record |
| `planner.ts` | Converts `WorkflowDefinition` into runtime `Step[]` via topological sort (Kahn's algorithm) |
| `expression.ts` | Resolves `{{input.x}}`, `{{steps.prev.output.data}}` at runtime; evaluates conditions |
| `executor.ts` | `ActionRegistry` (plugin registry) + `StepExecutor` (dispatch + timing) |
| `learner.ts` | Aggregates execution history — success rate, avg duration per action |

### 4. Governance Layer — `src/governance/`

Policy enforcement, approval workflows, and audit trails — built into the execution loop, not bolted on.

| File | Role |
|------|------|
| `policy-engine.ts` | `RulePolicyEvaluator` — data-driven rules evaluated at runtime (`amount_gt:1000`, `action:http.request`) |
| `approval-service.ts` | `ApprovalService` — manage pending approvals, resolve (approve/reject) |
| `audit-service.ts` | `AuditService` — immutable audit log of all significant actions |

### 5. Adapter Layer — `src/adapters/`

Concrete implementations of port interfaces. Default: in-memory for zero-dependency startup. Swap for durable stores without changing engine code.

| File | Implements |
|------|-----------|
| `memory-repositories.ts` | All 5 repository interfaces (Map/Array-backed) |
| `memory-event-bus.ts` | `EventBus` — in-process pub/sub with history tracking |
| `memory-queue.ts` | `WorkQueue` — synchronous pass-through (scaling boundary) |

### 6. Action Handlers — `src/actions/`

The plugin layer. Each handler has a `name` and an `execute(input, ctx)` method. Registered by name, looked up at runtime.

| Handler | Name | Purpose |
|---------|------|---------|
| `HttpRequestAction` | `http.request` | HTTP calls via `fetch` with timeout + abort |
| `TransformAction` | `transform` | Field mapping / data transformation |
| `FilterAction` | `filter` | Array filtering with operators (`==`, `!=`, `>`, `<`, `contains`) |
| `NoopAction` | `noop` | Pass-through for testing |
| `LogAction` | `log` | Execution logging for introspection |

### 7. API Layer — `src/api/`

Thin HTTP shell built with Fastify. Validates input with Zod, delegates to the engine/governance, returns JSON.

| File | Role |
|------|------|
| `app.ts` | Fastify factory — registers all route modules + `/health` |
| `schemas.ts` | Zod schemas for input validation |
| `container.ts` | DI container — wires the entire object graph |
| `routes/workflows.ts` | CRUD for workflow definitions |
| `routes/runs.ts` | Start, list, get, resume workflow runs |
| `routes/approvals.ts` | List pending, resolve (approve/reject) |
| `routes/actions.ts` | List registered action handler names |

---

## Design Patterns

### Hexagonal Architecture (Ports & Adapters)

The foundational pattern. The engine defines **port interfaces** (what it needs) and **adapters implement them** (how it's done). This means:

- The orchestrator never imports `MemoryRunRepository` — it uses `RunRepository` (the interface)
- Swapping from in-memory to PostgreSQL changes **one file** (`container.ts`)
- Tests inject fakes/mocks via the same interfaces

```
Engine ──depends on──▶ Port (interface)
                            ▲
                            │ implements
                       Adapter (concrete)
```

### Dependency Injection (Composition Root)

All dependencies are wired in one place: `Container`. No service locators, no god objects, no `new` scattered across the codebase. The container builds the full object graph once at startup.

```
Container
  ├── Adapters (repos, event bus, queue)
  ├── Engine (registry, executor, planner, learner, orchestrator)
  └── Governance (policy evaluator, approval service, audit service)
```

`getContainer()` provides a singleton. `resetContainer()` exists for test isolation.

### Domain-Driven Design (DDD)

Domain entities are **pure data + guarded state transitions**. No ORM, no framework coupling. Business rules are enforced in functions like `startStep()`, `completeRun()`, `approveRequest()` — each validates allowed transitions before mutating state.

```
STEP_TRANSITIONS = {
  Pending  → [Running, Skipped, Blocked]
  Running  → [Completed, Failed, Blocked, Skipped]
  Blocked  → [Running, Skipped]
  Failed   → [Running]  // retry
}
```

Invalid transitions throw `InvalidTransitionError`. The domain layer is the single source of truth for what state changes are legal.

### Domain Events

Every significant state change emits an event (`RunStarted`, `StepCompleted`, `ApprovalRequested`, etc.). Events are published through the `EventBus` port. Subscribers can react asynchronously — notifications, analytics, webhooks, side effects — without coupling to the emitter.

### Declarative Workflow Schema (Interpreter Pattern)

Workflows are **data, not code**. A `WorkflowDefinition` is a JSON document describing steps, dependencies, conditions, error strategies, and expressions. The engine **interprets** this at runtime:

```json
{
  "steps": [
    { "id": "fetch", "action": "http.request", "input": { "url": "..." } },
    { "id": "process", "action": "transform",
      "input": { "data": "{{steps.fetch.output.body}}" },
      "dependsOn": ["fetch"],
      "condition": "{{steps.fetch.output.body.status}} == 200",
      "onError": "skip" }
  ]
}
```

This is what makes it a **platform** — new business processes are added by writing definitions and action handlers, not by modifying the engine.

### Plugin Architecture (Strategy Pattern)

Action handlers are registered by name in the `ActionRegistry`. The executor looks them up at runtime. To add a new capability (Slack, Jira, database, S3, AI model call), you:

1. Implement the `ActionHandler` interface (one `name` + one `execute` method)
2. Register it: `registry.register(handler)`
3. Reference it in any workflow definition: `"action": "slack.notify"`

No engine changes. No redeployment of core logic.

### Expression Engine (Template Resolution)

Dynamic references in step inputs are resolved at runtime using `{{...}}` syntax. The expression engine:

- **Walks** the entire input value tree (objects, arrays, strings)
- **Resolves** `{{input.x}}`, `{{steps.stepId.output.field}}`, `{{steps.stepId.status}}`
- **Preserves types** — a single-expression string like `"{{input.count}}"` returns the raw number, not a string
- **Evaluates conditions** — `"{{input.amount}} > 1000"` → boolean, supporting `==`, `!=`, `>`, `<`, `>=`, `<=`

This keeps workflows declarative: no lambdas, no embedded code, just expressions.

### DAG-Based Execution Planning (Topological Sort)

Steps declare `dependsOn` edges. The planner runs **Kahn's algorithm** to produce a valid execution order:

1. Build adjacency list + in-degree map from `dependsOn`
2. Start with zero-in-degree steps
3. Process queue, decrementing in-degree of dependents
4. Detect cycles (if sorted count ≠ step count)

This enables future parallel execution of independent branches.

### State Machine (Guarded Transitions)

Both `WorkflowRun` and `Step` follow explicit state machines with transition maps. Each transition function checks the current state against allowed next states before mutating.

**Run states:**
```
Pending → Planning → Running → Completed
                  ↘            ↗
           WaitingForApproval
                  ↘
               Cancelled / Failed
```

**Step states:**
```
Pending → Running → Completed
   ↓         ↓ ↘
Skipped   Blocked  Failed → Running (retry)
```

### Governance as a First-Class Concern

Policies are not an afterthought — they're evaluated **inside the execution loop**, between expression resolution and action dispatch. The three governance components:

- **Policy Engine**: Data-driven rules. Match conditions → Allow / Require Approval / Deny
- **Approval Service**: Pause execution, create approval request, resume on resolution
- **Audit Service**: Immutable log of every significant action (creation, execution, approval)

### Execution Recording (Observer Pattern)

The `Learner` observes every step execution and records metrics (duration, success/failure, action name). `statsFor(action)` aggregates these into operational insights. This feeds back into planning — unreliable actions can be flagged, retry policies can be auto-tuned.

### Scaling Boundary (Abstract Factory via Port)

The `WorkQueue` port is the explicit scaling boundary:

- **Single-process**: `MemoryQueue` — synchronous pass-through, jobs execute inline
- **Distributed**: Swap for `RedisQueue` / `SQSQueue` — workers become separate processes consuming from a shared queue

The engine doesn't know or care which mode it's in. The adapter swap is a one-line change in the container.

---

## Dependency Flow

```
API Layer
    │  depends on
    ▼
DI Container
    │  constructs
    ▼
Engine + Governance
    │  depends on
    ▼
Ports (interfaces)
    ▲  implements
    │
Adapters (concrete)
```

**The dependency rule**: inner layers never depend on outer layers. The domain has zero imports from engine, governance, adapters, or API. The engine depends only on domain + ports. Adapters depend on domain + ports. The API depends on everything but is a thin shell.

---

## Testing Strategy

The architecture directly enables testability:

- **Domain tests**: Pure unit tests — no mocking needed, just call functions and assert state
- **Engine tests**: Inject fake action handlers and in-memory adapters via `buildTestDeps()`
- **Governance tests**: Direct unit tests against policy engine, approval/audit services
- **API tests**: Fastify's `inject()` for HTTP-level integration tests with a reset container per test

Every infrastructure concern is behind an interface, so tests never touch real databases, queues, or external APIs.
