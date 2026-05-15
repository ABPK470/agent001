# Enum catalog & lockdown rules

Every value with a finite domain — status, kind, mode, role, scope, source, tier, effect, decision, event-type — is represented as a TypeScript `enum`. No string unions, no inline literals, no `as const` arrays of strings. The compiler is the gatekeeper.

This document is the single source of truth for every enum-shaped concept across the `@mia/agent` and `@mia/server` packages.

## The mandatory pattern

Every enum file follows the same shape so the rules are mechanical and grep-able:

```ts
export enum FooKind {
  Alpha = "alpha",
  Beta  = "beta",
}

export const FOO_KINDS: ReadonlyArray<FooKind> = Object.freeze([
  FooKind.Alpha,
  FooKind.Beta,
])

export function isFooKind(value: unknown): value is FooKind {
  return typeof value === "string" && (FOO_KINDS as readonly string[]).includes(value)
}
```

* The wire string value MUST equal the value used historically in JSON / SQLite, so the enum migration is type-only and zero-runtime-risk.
* The `_VALUES` array MUST be `Object.freeze`d so it can be reflected at runtime (CHECK-constraint generation, route validation) without leaking writability.
* The `isFoo` guard MUST be the only entry point used at trust boundaries (HTTP body, DB row, external event payload).

## Where enums live

* `packages/agent/src/engine/enums/<domain>.ts` — anything imported by the agent package OR shared across packages. Re-exported from `engine/enums/index.ts` → `engine/index.ts` → `lib.ts` so consumers import from `@mia/agent`.
* `packages/server/src/enums/<domain>.ts` — server-only domains (channels, memory, browser, sandbox, attachments-server-extensions, …). Re-exports from `@mia/agent` are used when an enum is cross-package (e.g. `AttachmentScope`).

## Catalog

| Enum | File | Used in DB column | CHECK |
| ---- | ---- | ----------------- | ----- |
| `RunStatus` | `agent/engine/enums/run.ts` | `runs.status` | ✅ |
| `MessageRole` | `agent/engine/enums/message.ts` | (none — chat wire only) | – |
| `EventType` | `agent/engine/enums/event.ts` | `event_log.type` | ❌ (≈100 values; validated at boundary in `operations.ts`) |
| `EventNamespace` | `agent/engine/enums/event.ts` | derived | – |
| `AttachmentScope` | `agent/engine/enums/attachment.ts` | `attachments.scope` | ✅ |
| `PolicyEffect` | `agent/engine/enums/policy.ts` | `policy_rules.effect` | ✅ |
| `PolicyRunMode`, `PolicyRole`, `PolicyScope`, `PolicyDbEnvironment`, `PolicyDbOperation`, `PolicyNetwork` | `agent/engine/enums/policy.ts` | (in-memory rule fields) | – |
| `SyncRunStatus` | `agent/engine/enums/sync.ts` | `sync_runs.status` | ✅ |
| `EnvRole`, `EnvAccessMode`, `DiscoverySource` | `agent/engine/enums/sync.ts` | (config / discovery) | – |
| `DiagnosticCategory`, `DiagnosticSeverity`, `PlannerNeedLevel`, `PipelineStatus`, `StepRole`, `VerifierOutcome`, `VerifierIssueSeverity`, `PlannerRepairCompatibilityMode` | `agent/engine/enums/planner.ts` | (in-memory) | – |
| `ToolOutcomeSeverity`, `ToolControlDirective`, `ToolCallAction`, `TaskIntent`, `EscalationAction`, `BanditArmId`, `DelegationHardBlockedMatchSource` | `agent/engine/enums/delegation.ts` | (in-memory) | – |
| `ExportFormat`, `BaseSectionKey` | `agent/engine/enums/context.ts` | (in-memory) | – |
| `MemoryTier` | `server/enums/memory.ts` | `memory_entries.tier` | ✅ |
| `MemoryRole` | `server/enums/memory.ts` | `memory_entries.role` | ✅ |
| `MemorySource` | `server/enums/memory.ts` | `memory_entries.source` | ✅ |
| `ChannelType` | `server/enums/channels.ts` | `conversations/outbound_messages/channel_configs.{channel_type,type}` | ✅ |
| `DeliveryStatus` | `server/enums/channels.ts` | `outbound_messages.status`, `delivery_attempts.status` | ✅ |
| `AttachmentIngestionMode` | `server/enums/attachments.ts` | `attachments.ingestion_mode` | ✅ |
| `AttachmentStatus` | `server/enums/attachments.ts` | `attachments.status` | ✅ |
| `AttachmentSource` | `server/enums/attachments.ts` | `attachments.source` | ✅ |
| `AttachmentImportMode` | `server/enums/attachments.ts` | `attachment_imports.import_mode` | ✅ |
| `EffectKind` | `server/enums/effects.ts` | `effects.kind` | ✅ |
| `EffectStatus` | `server/enums/effects.ts` | `effects.status` | ✅ |
| `OperationKind`, `OperationStatus` | `server/enums/operations.ts` | (derived view in `operations.ts`) | – |
| `RunPriority`, `RunTaskType`, `RunProfile` | `server/enums/run-workspace.ts` | (queue/runtime) | – |
| `SandboxBackendKind` | `server/enums/sandbox.ts` | (config) | – |
| `LlmProvider` | `server/enums/llm.ts` | `llm_config.provider` (write-side enforced) | – |
| `CredentialKind` | `server/enums/credentials.ts` | `browser_credentials.kind` | ✅ |
| `BrowserDecision` | `server/enums/browser.ts` | `browser_audit_log.decision` | ✅ |
| `PolicyDomainEffect` (allow/deny) | inline in `connection.ts` | `browser_domain_policy.effect` | ✅ |

## Schema versioning

* `packages/server/src/db/connection.ts` exports `SCHEMA_VERSION` (currently `18`).
* When any column's enum domain changes (member added/removed), bump `SCHEMA_VERSION` and `HARD_RESET_THRESHOLD`. The migration in `_migrate()` will then drop and re-create every app table on next boot to pick up the new CHECK clause. Local-dev only — data loss is acceptable.

## Lockdown rules

These rules are enforced by code review (no ESLint plugin). The compiler will catch most violations because every domain field is typed as the enum.

1. **Never re-introduce string-union aliases or inline literal unions** for any concept already in this catalog. If a new finite domain appears, add a new enum file using the mandatory pattern.
2. **Never write `as Foo` at a non-trust-boundary**. The only acceptable casts are at:
   * SQLite row reads — safe because the column has a CHECK constraint matching the enum.
   * `Object.values(Foo)` reflection inside the enum file itself.

   Everywhere else, validate with the `isFoo` guard.
3. **Network and event-stream boundaries** (HTTP request bodies, webhook payloads, SSE consumers) MUST guard with `isFoo` and reject on failure.
4. **The DB write path** SHOULD use the typed enum value, never a string literal — let the compiler refuse a typo before it reaches the prepared statement.
5. **`enum X { Foo = "foo" }`** — string-valued enums only. Numeric enums are forbidden because the wire payloads carry the string and we don't want runtime mismatch when an external system serialises.
6. **CHECK constraints** must list values literally and exactly match the enum. When adding a member, update the CHECK in the same commit and bump `SCHEMA_VERSION`.

## Why this matters

The original failure mode was `inferPipelineStatus` in `packages/server/src/operations.ts` doing `t.endsWith(".completed")` on event-type strings — which silently returned success on a `sync.execute.completed` event even when an earlier `sync.execute.step.failed` had already poisoned the run. With `EventType` plus `isCompletionEvent` / `isFailureEvent` / `isSubStepFailureEvent` predicates, that class of bug is impossible: every event-type comparison goes through an exhaustive-switch path the compiler validates.

The CHECK constraints are defense-in-depth. Even if a future contributor bypasses the type system with `as any`, the database itself will reject the write.
