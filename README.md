# agent001

**Agentic Automation Platform** — a generic, declarative workflow engine where AI agents execute end-to-end work across UIs and APIs with governance built in.

Business users define outcomes as declarative workflow definitions. The engine plans execution order, resolves dynamic expressions, enforces policies, and dispatches to pluggable action handlers. No orchestration logic is hardcoded — everything is driven by data.

## Architecture

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
│  Action Handlers (pluggable — register any at runtime)      │
│  ┌───────────┐ ┌─────────┐ ┌────────┐ ┌──────┐ ┌─────┐    │
│  │http.request│ │transform│ │ filter │ │ noop │ │ log │    │
│  └───────────┘ └─────────┘ └────────┘ └──────┘ └─────┘    │
│  + any custom handlers you register                         │
├─────────────────────────────────────────────────────────────┤
│  Governance                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                  │
│  │ Policies │  │ Approvals│  │  Audit   │                  │
│  └──────────┘  └──────────┘  └──────────┘                  │
├─────────────────────────────────────────────────────────────┤
│  Domain (pure TypeScript — zero dependencies)               │
│  Models · Events · Enums · Errors · WorkflowDefinition      │
├─────────────────────────────────────────────────────────────┤
│  Ports & Adapters                                           │
│  Repositories · Event Bus · Work Queue (scaling boundary)   │
└─────────────────────────────────────────────────────────────┘
```

### What makes this a platform (not a custom app)

| Concern | How it's generic |
|---|---|
| **Orchestration** | The orchestrator is a generic loop that interprets `WorkflowDefinition` data. It knows nothing about business logic. |
| **Steps** | Defined declaratively as JSON. Each step references an action handler by name (e.g. `"http.request"`, `"transform"`). |
| **Expressions** | Dynamic values like `{{steps.fetch.output.data}}` or `{{input.amount}}` are resolved at runtime. Business logic stays in definitions, not code. |
| **DAG execution** | Steps declare `dependsOn` edges. The planner topologically sorts them (Kahn's algorithm). Parallel execution is structurally enabled. |
| **Action handlers** | Register any handler at runtime via `ActionRegistry`. The engine looks them up by name. Write a handler for Slack, Jira, SAP, a database — anything. |
| **Conditional steps** | Steps can have a `condition` expression. Falsy → skip. No hardcoded branching. |
| **Error strategies** | Per-step `onError`: `"fail"` (default), `"skip"`, `"continue"`. Declared in the workflow, not coded. |
| **Policies** | Data-driven rules evaluated at runtime. Add/remove rules via API or code. |
| **Scaling** | `WorkQueue` port separates job dispatch from execution. Swap the adapter to distribute across workers. |

## Project structure

```
src/
├── domain/            # Pure domain: models, enums, events, errors, workflow schema
├── ports/             # Interface contracts (repositories, services, work queue)
├── engine/            # Generic engine: planner, expression resolver, orchestrator, executor, learner
├── actions/           # Built-in action handlers (http, transform, filter, noop, log)
├── governance/        # Policy engine, approval service, audit service
├── adapters/          # In-memory implementations (repos, event bus, queue)
├── api/               # Fastify HTTP layer + DI container
│   └── routes/
└── index.ts           # Server entry point

tests/
├── domain/            # Model transition tests
├── engine/            # Expression, planner, executor, orchestrator tests
├── governance/        # Policy, approval, audit tests
└── api/               # HTTP endpoint integration tests
```

## Quick start

```bash
# Prerequisites: Node.js >= 20

# Install dependencies
npm install

# Run tests (71 tests)
npm test

# Start development server (auto-reload)
npm run dev

# Build and run production
npm run build
npm start
```

The server starts on `http://localhost:3000` by default. Configure via `PORT` and `HOST` environment variables.

## Usage example

### 1. Define a workflow

```bash
curl -X POST http://localhost:3000/workflows \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Order Processing",
    "description": "Validate order, check inventory, send confirmation",
    "inputSchema": {
      "orderId": { "type": "string", "required": true },
      "amount": { "type": "number" }
    },
    "steps": [
      {
        "id": "validate",
        "name": "Validate Order",
        "action": "http.request",
        "input": {
          "url": "https://api.example.com/orders/{{input.orderId}}",
          "method": "GET"
        }
      },
      {
        "id": "check_inventory",
        "name": "Check Inventory",
        "action": "http.request",
        "input": {
          "url": "https://api.example.com/inventory/check",
          "method": "POST",
          "body": { "orderId": "{{input.orderId}}" }
        },
        "dependsOn": ["validate"],
        "condition": "{{steps.validate.output.body.status}} == 200"
      },
      {
        "id": "notify",
        "name": "Send Confirmation",
        "action": "http.request",
        "input": {
          "url": "https://api.example.com/notifications",
          "method": "POST",
          "body": { "message": "Order {{input.orderId}} confirmed" }
        },
        "dependsOn": ["check_inventory"],
        "onError": "skip"
      }
    ]
  }'
```

### 2. Run it

```bash
curl -X POST http://localhost:3000/workflows/{workflowId}/runs \
  -H "Content-Type: application/json" \
  -d '{ "input": { "orderId": "ORD-123", "amount": 99.99 } }'
```

### 3. Register custom action handlers

```typescript
import { getContainer } from "./api/container.js";
import type { ActionHandler } from "./engine/executor.js";

const slackNotify: ActionHandler = {
  name: "slack.notify",
  async execute(input) {
    // Your Slack integration logic
    return { sent: true, channel: input.channel };
  },
};

getContainer().actionRegistry.register(slackNotify);
// Now any workflow can use action: "slack.notify"
```

## API endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `POST` | `/workflows` | Create & activate a workflow |
| `GET` | `/workflows` | List all workflows |
| `GET` | `/workflows/:id` | Get a workflow |
| `POST` | `/workflows/:id/runs` | Start a workflow run |
| `GET` | `/workflows/:id/runs` | List runs for a workflow |
| `GET` | `/workflows/:id/runs/:runId` | Get a specific run |
| `POST` | `/workflows/:id/runs/:runId/resume` | Resume after approval |
| `GET` | `/approvals` | List pending approvals |
| `POST` | `/approvals/:id/resolve` | Approve or reject |
| `GET` | `/actions` | List registered action handlers |

## Execution loop

```
1. POST /workflows/:id/runs with input
2. Planner topologically sorts steps via dependsOn → execution plan
3. For each step in order:
   a. Evaluate condition expression → skip if false
   b. Resolve {{...}} expressions in step input (referencing previous outputs)
   c. PolicyEvaluator checks governance rules → block if approval required
   d. Dispatch to registered ActionHandler by name
   e. Record execution result → update context for subsequent steps
   f. On failure: apply onError strategy (fail | skip | continue)
4. All steps done → run completed
```

## Scaling

### Current: single-process (good for dev, moderate workloads)

The default setup runs everything in one Node.js process with in-memory storage. This is the simplest deployment and sufficient for many use cases.

### Scaling path: stateless workers + shared state

The architecture is designed for horizontal scaling via the **ports & adapters** pattern. Every infrastructure concern is behind an interface:

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  API Server │────→│  Work Queue  │────→│  Workers    │
│  (stateless)│     │ (Redis/SQS/  │     │ (stateless, │
│             │     │  RabbitMQ)   │     │  N replicas)│
└─────────────┘     └──────────────┘     └─────────────┘
       │                                        │
       └──────────┐               ┌─────────────┘
                  ▼               ▼
          ┌──────────────────────────┐
          │   Shared State Store     │
          │  (PostgreSQL / Redis)    │
          └──────────────────────────┘
```

**To scale:**

1. **Replace `MemoryQueue` with a distributed queue** (Redis, RabbitMQ, SQS):

   ```typescript
   // Implement the WorkQueue interface
   class RedisQueue implements WorkQueue {
     async enqueue(job: StepJob) { /* push to Redis stream */ }
     process(handler: (job: StepJob) => Promise<void>) { /* consume from stream */ }
   }
   ```

2. **Replace in-memory repositories with persistent stores** (PostgreSQL, Redis):

   ```typescript
   class PostgresRunRepository implements RunRepository {
     async save(run: WorkflowRun) { /* INSERT/UPDATE */ }
     async get(id: string) { /* SELECT */ }
     async listByWorkflow(workflowId: string) { /* SELECT WHERE */ }
   }
   ```

3. **Replace `MemoryEventBus` with a distributed bus** (Redis Pub/Sub, Kafka):

   ```typescript
   class RedisEventBus implements EventBus {
     async publish(event: DomainEvent) { /* PUBLISH to channel */ }
     subscribe(type: string, handler: Handler) { /* SUBSCRIBE */ }
   }
   ```

4. **Run multiple worker processes** — they're stateless, consuming from the shared queue and writing results to the shared store.

5. **Wire it up in the container** — change only `container.ts`:

   ```typescript
   class ProductionContainer extends Container {
     readonly runRepo = new PostgresRunRepository(pool);
     readonly queue = new RedisQueue(redis);
     readonly eventBus = new RedisEventBus(redis);
   }
   ```

**No engine code changes.** The orchestrator, planner, expression engine, and action handlers all work identically regardless of what's behind the ports.

### What scales independently

| Component | Scales by | Bottleneck relief |
|---|---|---|
| **API servers** | Run N replicas behind a load balancer | More concurrent workflow submissions |
| **Step workers** | Run N processes consuming from queue | More concurrent step executions |
| **State store** | PostgreSQL replicas / Redis cluster | Read throughput for run status queries |
| **Event bus** | Kafka partitions / Redis Pub/Sub | Event fan-out to subscribers |

### Performance characteristics

- **Single-process**: ~1000s of concurrent runs (limited by memory for in-memory stores)
- **With PostgreSQL + Redis queue**: ~10,000s of concurrent runs per worker pool
- **Execution is I/O-bound** (HTTP calls, API integrations), not CPU-bound — scales linearly with workers

MIT
