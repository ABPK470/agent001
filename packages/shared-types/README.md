# `@mia/shared-types`

Wire-format DTOs (data transfer objects) that cross any HTTP / WS / SSE
boundary between the `agent`, `server`, and `ui` packages.

## Properties

- **Zero runtime dependencies.** Pure type declarations; browser-safe ESM.
- **Depends on `@mia/shared-enums`** for value-set primitives (every
  enum field on a wire DTO is typed with the canonical enum).
- **No compile step.** `exports["."]` points at `./src/index.ts`;
  consumers (esbuild for the server bundle, Vite for the UI, tsc for
  tests) resolve TypeScript source. Do not add a build step that tools
  depend on.

## Scope

Lives here:

- `Run`, `RunDetail`, `Step`, `TraceEntry` (the SSE trace stream payload)
- `LogEntry`, `AuditEntry`, `Notification`
- `WorkspaceDiff`, `WorkspaceDiffApplyResult`
- `SyncRecipe`, `SyncPlan`, `SyncEnvironment`, `SyncExecuteProgress`
- `AgentDefinition`, `ToolInfo`, `PolicyRule`
- `RollbackResult`, `RollbackPreview`
- Layout and dashboard view-config shapes (`Widget`, `WidgetType`,
  `ViewConfig`, `LayoutItem`, `SavedLayout`)

Does **not** live here:

- **Internal state shapes** that never serialise across packages — keep
  in the owning package.
- **Zod schemas / runtime parsers** — would add a runtime dep. If/when
  a `@mia/shared-schemas` package is introduced, parsers go there and
  this package stays type-only.

## Adoption status

- ✅ `@mia/ui` re-exports its old `src/types.ts` from here.
- ⏳ `@mia/server` and `@mia/agent` still shape these DTOs implicitly. A
  future pass should import the types here when emitting / persisting
  trace + run records so the contract is enforced statically end-to-end.
