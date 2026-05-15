# The Agent System — Plain English Tour

A walk through `packages/agent/src/` cluster by cluster. What each part is, what it's responsible for, and why it's shaped the way it is. At the end, a section on the overall coding style — whether it's coherent or a blob of mismatched patterns.

---

## 1. The whole thing in one paragraph

An **agent** is `LLM + Tools + Loop`. You give it a goal, it asks the LLM what to do, the LLM either replies with text (done) or asks for tool calls (execute, feed results back, ask again). Everything in this package is either:

- the loop itself,
- the tools the LLM can call,
- the prompt/context the LLM sees,
- safety nets that watch the loop (recovery, governance, completion guards),
- a structured planner that can run the loop in a more disciplined way for complex goals,
- or a delegation system so the agent can spawn sub-agents.

That's it. Every folder below is one of those six things.

---

## 2. The root files (`src/`)

These are the public face of the package and the few cross-cutting primitives.

| File              | Role                                                                                                                                |
|-------------------|--------------------------------------------------------------------------------------------------------------------------------------|
| `agent.ts`        | The `Agent` class. Owns the loop. Public entry point.                                                                                |
| `lib.ts`          | Barrel export — what other packages import.                                                                                          |
| `cli.ts`          | A thin CLI wrapper for running an agent locally.                                                                                     |
| `types.ts`        | The vocabulary: `Tool`, `Message`, `LLMClient`, `LLMResponse`, `AgentConfig`, `TokenUsage`. Everything else speaks in these types.  |
| `constants.ts`    | Magic numbers in one place (limits, defaults).                                                                                       |
| `logger.ts`       | A trivial logger, not a framework.                                                                                                   |
| `planner-routing.ts` + `planner-routing/` | The decision "should this goal go through the structured planner, or just let the loop wing it?"                |

The `Agent` class is small on purpose. It holds config and orchestrates one iteration at a time. All the actual work is delegated to a folder.

---

## 3. `loop/` — what one iteration of the agent loop does

This is the literal mechanics of `while (not done) { ask LLM; run tools; check; repeat }`.

| File                       | Responsibility                                                                                       |
|----------------------------|------------------------------------------------------------------------------------------------------|
| `agent-loop-state.ts`      | The mutable state for one run: messages so far, iteration count, stuck counters, budget tracking.    |
| `system-prompt.ts`         | The default system prompt. Just a string + small builders.                                           |
| `tool-execution.ts`        | Run one tool call: argument parsing, timeout, kill-switch, result enrichment.                        |
| `post-round.ts`            | After every iteration: am I making progress? am I looping on the same call? do I need a hint?       |
| `completion-guards.ts`     | When the LLM says "I'm done", verify it. Did it actually finish, or is it bailing early?            |

The split between `agent.ts` and `loop/` is the split between "owning the run" and "doing one step of the run". `agent.ts` doesn't know about kill managers or stuck detection. `loop/` doesn't know how the run was kicked off.

There's also a sibling folder `agent/` (no `s`) with three helpers (`agent-helpers.ts`, `iteration-prepare.ts`, `iteration-tool-round.ts`). Those are pieces of `agent.ts` that got too large and were extracted. They live alongside `agent.ts` because they're its private internals, not reusable building blocks. Compare with `loop/` which IS reusable conceptually.

---

## 4. `context/` — what the LLM sees

The LLM has a finite context window. The agent generates a lot of message history. Something has to decide what gets sent on each call.

| File                        | Responsibility                                                                                              |
|-----------------------------|-------------------------------------------------------------------------------------------------------------|
| `context-management.ts`     | The cheap path: estimate tokens, truncate old messages, compact verbose tool outputs.                       |
| `context-truncation.ts`     | The mechanics of cutting messages while preserving structure (don't break a tool_use without its result).   |
| `context-compaction.ts`     | The expensive path: summarise long file reads, build a "resume anchor" so the LLM remembers what it knew.   |
| `prompt-budget.ts` + `prompt-budget-helpers.ts` + `prompt-budget-types.ts` + `prompt-budget/` | A token budget: each kind of content (system, tools, history, tool results) gets a share, and the planner decides how to allocate. |

This cluster is purely about **fitting reality into the context window**. It has no opinions about what the agent should do — only about how much it can be told.

---

## 5. `tools/` — what the agent can actually do

Each tool is a function the LLM is allowed to call. They are described to the LLM in the tool list, and `loop/tool-execution.ts` dispatches calls to them.

Categories visible in the folder:

- **Filesystem**: `filesystem.ts`, `filesystem-integrity.ts`, `filesystem-security.ts`, `search-files.ts` — read, write, search, with safety checks.
- **Shell**: `shell/`, `shell.ts` — run commands, with sandboxing.
- **Web**: `fetch-url.ts`, `browse-web.ts`, `browser-check.ts` — HTTP and browser automation.
- **Database**: `mssql*` — connect, list, query, profile, infer relationships.
- **Sync** (domain-specific): `sync-tools.ts`, `catalog*` — the data-sync feature surface.
- **Meta-tools**: `delegate.ts`, `delegate-spawn/` (spawn a sub-agent for a sub-goal), `ask-user.ts` (ask a clarifying question), `think.ts` (a no-op that lets the LLM "think out loud").

Tools are plain functions. They're not classes, not injected, not abstracted behind interfaces. The LLM's tool-call JSON gets routed to a function that returns a result. The whole "tool" abstraction is about thirty lines of glue.

---

## 6. `planner/` — the structured execution path

This is the biggest folder (~30 files) and the easiest to misread. Here is the whole thing in one sentence:

> **The planner is one orchestrator + one pipeline. Every other file is a sub-step of the pipeline (parse, validate, verify, repair).**

Conceptually:

```
goal → orchestrator
        ├─ generate (LLM produces a plan)
        ├─ parse  (turn plan text into a structured Plan)
        ├─ validate (does the Plan obey our rules?)
        ├─ pipeline (execute the Plan step-by-step, with each step being a real tool call)
        ├─ verify (did the executed step actually achieve what was claimed?)
        └─ repair (if verify failed, patch the Plan and re-run from where it broke)
```

Each of those words is a folder or file:

- `generate/`, `generate-parse/`, `generate.ts`, `generate-parse.ts`, `generate-prompts.ts`
- `decision/`, `decision-patterns.ts`, `decision.ts` — sub-decisions inside a plan step
- `validate/`, `validate-checks.ts`, `validate.ts`
- `pipeline/`, `pipeline-context.ts`, `pipeline.ts`, `pipeline-steps/`, `pipeline-steps.ts`, `pipeline-validation/`, `pipeline-repair/`
- `verifier/`, `verifier-blueprint/`, `verifier-helpers/`, `verifier-integration/`, `verifier-llm/`, `verifier-probes/` — different verification strategies (blueprint check, DOM probe, LLM judgement)
- `coherent/`, `coherent.ts`, `coherent-parse.ts` — the "is the answer coherent with the goal" check
- `blueprint-contract/` — declarative contracts a plan must satisfy
- `circuit-breaker.ts`, `runtime-model.ts`, `polish-failure.ts`, `platform-errors.ts` — operational concerns
- `index.ts`, `index-blueprint.ts`, `index-orchestrator.ts`, `index-orchestrator/`, `index-normalize.ts`, `index-remediate.ts`, `index-synthesize.ts` — the orchestrator entry points

**Why so many files?** Each sub-step has its own validation, its own repair logic, its own types. Splitting them gave us the ≤300 LOC discipline. The folder feels heavy because you see all 30 files at once; the runtime path through them is short and linear.

**Why isn't the planner a class / service?** It has no external dependency to abstract. It's a pure pipeline of functions: `(goal, llm, tools) → Plan + execution result`. There's nothing to mock, nothing to swap. Wrapping it in a class would just be ceremony.

---

## 7. `recovery/` — when things go wrong

The agent gets stuck. Tools fail. The LLM repeats itself. This cluster is the diagnostic + nudge layer.

| File                          | Responsibility                                                                              |
|-------------------------------|---------------------------------------------------------------------------------------------|
| `recovery.ts`                 | Public API: build hints, detect failures, compute a "quality proxy" score for tool outputs. |
| `recovery-detectors.ts`       | Pattern-match common failure shapes (timeouts, permission errors, missing files, etc.).     |
| `recovery-hints-advanced.ts`  | More elaborate hints (cross-call patterns).                                                 |
| `advanced-build.ts`, `per-call-hints.ts` | Building blocks used by the above.                                               |
| `circuit-breaker.ts`          | After N consecutive failures of the same tool, stop trying.                                 |
| `retry.ts`                    | Exponential backoff retry policy for transient errors.                                      |

`loop/post-round.ts` calls into here after each iteration. The recovery layer doesn't decide what to do — it just produces a hint. The loop decides whether to inject it.

---

## 8. `delegation/` — sub-agents

When the planner decides "this sub-goal is big enough to deserve its own agent," it spawns one. Delegation is its own cluster because that decision is non-trivial:

| File                                       | Responsibility                                                                |
|--------------------------------------------|-------------------------------------------------------------------------------|
| `delegation-decision.ts` + `delegation-decision/` | "Should we delegate this task? At what cost/budget?"                   |
| `delegation-decision-safety.ts`           | Safety checks on the decision (don't delegate forever).                       |
| `delegation-validation.ts` + `delegation-validation/` | "Did the sub-agent actually do what it was told?"                  |
| `delegation-validation-correction.ts`     | If validation fails, can we patch the sub-agent's output?                     |
| `delegation-validation-patterns.ts` + `delegation-validation-patterns/` | The library of validation rules.                  |
| `delegation-learning.ts`                  | Multi-armed bandit that learns over time which delegation strategies work.    |
| `escalation.ts`                           | When delegation fails: escalate back to the parent agent.                     |

Delegation is the most "stateful" cluster — the bandit tuner persists across runs. It's also the one most likely to feel like over-engineering until you've seen the agent loop forever because it kept delegating to a sub-agent that kept failing.

---

## 9. `governance/` — policies, audits, quality

This is the layer between "agent runs" and "we trust the result". It wraps tool calls and runs in a contract.

| File                  | Responsibility                                                                                       |
|-----------------------|------------------------------------------------------------------------------------------------------|
| `governance.ts`       | `runGoverned(...)`, `governTool(...)`, `createEngineServices(...)`. The public API.                  |
| `governance-types.ts` | The vocabulary: `RunState`, `GovernedResult`, `EngineServices`.                                      |
| `governance-report.ts`| Pretty-printed run summary (token usage, tool outcomes, policy events).                              |
| `govern-tool.ts`      | Wraps a single tool call: enforce policy, audit it, count it against the run's quotas.               |
| `quality-proxy.ts`    | Cheap heuristics to estimate "did this tool call produce something useful?"                           |
| `code-quality.ts` + `code-quality/` | If the agent wrote code, run static checks (length, branching, patterns).                  |

Governance doesn't replace the loop — it sits above it. You can use the `Agent` class without governance for ad-hoc runs, or wrap it with `runGoverned` for production where you need audit trails.

---

## 10. `tool-helpers/` — the tool-call plumbing

Shared utilities that any tool or anything calling a tool needs.

| File                          | Responsibility                                                                  |
|-------------------------------|---------------------------------------------------------------------------------|
| `tool-utils.ts` + `tool-utils/` | Argument parsing, exec-with-timeout, permission checks, stuck detection.      |
| `tool-result.ts`              | The shape of a tool result + helpers to inspect it.                             |
| `tool-progress.ts`            | Progress events emitted while a tool is running (for the UI).                   |
| `tool-contract-guidance.ts`   | "When you call this tool, here are the expected pre/post conditions." Injected into prompts. |

This is pure mechanical glue. No policy, no decisions.

---

## 11. `engine/` — the governance runtime

`governance/` is the API surface. `engine/` is the implementation it sits on.

| File              | Responsibility                                                                          |
|-------------------|-----------------------------------------------------------------------------------------|
| `index.ts`        | `createEngineServices()` — wires the lot together.                                       |
| `interfaces.ts`   | The interfaces governance speaks to (so they can be swapped in tests).                  |
| `models.ts`       | Domain types: `Run`, `Step`, `ToolInvocation`.                                           |
| `enums.ts`        | Status enums (`RUNNING`, `SUCCESS`, `FAILED`, ...).                                      |
| `errors.ts`       | Typed error classes.                                                                     |
| `events.ts`       | Event bus for the engine (run started, step completed, etc.).                           |
| `audit.ts`        | Append-only audit log of everything the agent did.                                       |
| `policy.ts`       | "Is this tool call allowed under current policy?"                                        |
| `memory.ts`       | Persisted memory across runs (knowledge the agent has accumulated).                      |
| `learner.ts`      | Hooks for the bandit/learning pieces.                                                    |

This is the only cluster shaped like a "service": it has interfaces and a wiring function (`createEngineServices`). That's because governance needs to be **swappable** in tests — you don't want a real audit log in unit tests. The other clusters don't need that, so they don't have it.

---

## 12. `llm/` — the model adapters

Two files: `openai-compat.ts`, `databricks.ts`. Each implements the `LLMClient` interface from `types.ts`. Adding a new provider = one new file. There's no abstract `LLMProvider` base class because there's nothing to share — they all just translate to/from the provider's HTTP API.

---

## 13. `sync/` — a domain feature

This is not part of the agent core. It's a feature built on top of the agent: a data-sync orchestrator with diff engines, recipes, environments, run sinks. It uses the agent (via tools in `tools/sync-tools.ts`) but the agent doesn't depend on it.

It lives in this package because it shares types and is co-developed with the agent. In a larger system it would graduate to its own package.

---

## 14. `internal/` — small private helpers

`json.ts`, `paths.ts`. Used by everything, exposed by nothing. These are the kind of file that exists because rewriting `JSON.parse` with error handling for the tenth time was annoying.

---

# The meta question — is this a coherent codebase or a blob?

You asked whether the system is a mix of styles with no true path. Here is the honest answer.

## The dominant style is "modules of functions"

Almost everything is a `.ts` file that exports a few named functions and types. No DI container. No service locator. No repository pattern. No event sourcing. Functions take their dependencies as parameters; if a function needs a logger it gets one as an argument; if it needs an LLM it gets one as an argument.

This is the **functional core, imperative shell** style. The "shell" is `Agent`, the loop, and `runGoverned`. The "core" is everything they call.

## Where there ARE classes, there's a reason

There are very few classes:

- **`Agent`** — holds long-lived configuration and state across many calls. A pure function would have a 20-argument signature. So it's a class.
- **`ToolFailureCircuitBreaker`** — has internal counters that change between calls. Stateful → class.
- **`DelegationBanditTuner`** — multi-armed bandit accumulates statistics over time. Stateful → class.

Pattern: **state lives in classes; logic lives in functions**. That's consistent.

## Where there ARE services (interface + factory), there's a reason

Only one cluster does this: `engine/` (with `governance/` as its API). It has `interfaces.ts` and `createEngineServices()`. Why? Because audit logs, policy engines, and memory stores have **real external dependencies** (file system, databases) that we want to swap in tests.

The planner doesn't get this treatment because it has no external dependency to abstract — it's `(goal, llm, tools) → result`. The loop doesn't either. The tools don't either. **Services exist where there is something to mock or swap; nowhere else.**

## "Should we have more services?"

No. Adding a service for something that has only one implementation and no mocking need is ceremony — you write `IThing`, `Thing`, `ThingFactory`, register it, inject it, and gain nothing. The codebase resists this on purpose.

The thing to watch out for is the inverse: **state slowly leaking into modules that should be pure**. If `recovery.ts` started keeping a global mutable cache of failures, that would be a smell. So far it doesn't.

## Why the file count is so high

We hold a hard rule: every file ≤300 LOC. That mechanically produces ~150 files for a system that could be ~30 files of 1500 LOC each. The trade-off is:

- **Cost**: more files to navigate, deeper folders, more imports.
- **Win**: every file fits on one screen, every file does one thing, refactors are local, code review is bounded.

This is why the clusters exist. Without clustering you'd have 50 files at the root of `src/` and the win would turn into a loss. With clustering you have ~16 entries at the root, each a clear noun. The cluster name tells you the responsibility; the files inside are the implementation.

## Verdict

It is **not a blob of mixed paradigms**. The whole codebase commits to:

1. **Functions over classes**, except where state is genuinely long-lived.
2. **Pass dependencies as arguments**, no DI framework.
3. **One service cluster (`engine/`)**, because that's the one place that benefits from mocking.
4. **Cluster by responsibility**, not by technical layer (no `controllers/`, `models/`, `utils/` everywhere).
5. **≤300 LOC per file**, enforced.
6. **Public API in `lib.ts`**, internals never reached into by other packages.

The risks to watch:

- **The planner cluster keeps growing.** It's already the biggest. If it doubles again, it should probably split into `planner/` and `verifier/`.
- **`tools/` has both generic tools (filesystem, shell) and domain tools (sync, mssql).** Eventually domain tools should leave this package.
- **`sync/` doesn't really belong in the agent package.** It's a customer of the agent, not part of it. Same fix.

But none of these are paradigm mixes. They're all "this folder grew bigger than its name implies." That's a refactor away, not a rewrite.
