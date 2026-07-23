/** Auto-seeded cycle debt — shrink only; do not grow casually. */
export const CYCLE_ALLOWLIST = [
  {
    "pkg": "ui",
    "key": "components/InlineDiagram.tsx→components/charts/Dashboard.tsx→components/charts/index.tsx",
    "note": "Barrel/sibling cycle debt — extract leaf module; allowlists must shrink"
  },
  {
    "pkg": "ui",
    "key": "components/charts/Dashboard.tsx→components/charts/index.tsx",
    "note": "Barrel/sibling cycle debt — extract leaf module; allowlists must shrink"
  },
  {
    "pkg": "agent",
    "key": "core/choose-path.ts→core/choose-path/index.ts→core/plan.ts→core/plan/index.ts→core/plan/orchestrator/index.ts→core/plan/orchestrator/orchestrate.ts→runtime/agent.ts→runtime/delegate.ts→runtime/delegate/index.ts→runtime/delegate/validation/index.ts→runtime/run-a-goal/index.ts→runtime/run-a-goal/run-goal.ts→runtime/run-a-goal/steps/try-planner-path.ts→tools/delegate-spawn/index.ts→tools/delegate-spawn/spawn.ts→tools/index.ts",
    "note": "Barrel/sibling cycle debt — extract leaf module; allowlists must shrink"
  },
  {
    "pkg": "agent",
    "key": "core/doctrine.ts→core/doctrine/aggregate-naming.ts→core/doctrine/index.ts→tools/catalog-search/index.ts→tools/catalog-search/tool.ts→tools/catalog/graph/build.ts→tools/catalog/graph/index.ts→tools/catalog/index.ts→tools/database/mssql/export-tool.ts→tools/database/mssql/index.ts→tools/database/mssql/trace.ts→tools/index.ts",
    "note": "Barrel/sibling cycle debt — extract leaf module; allowlists must shrink"
  },
  {
    "pkg": "agent",
    "key": "core/doctrine.ts→core/doctrine/big-view-budget.ts→core/doctrine/index.ts→tools/catalog-search/index.ts→tools/catalog-search/tool.ts→tools/catalog/graph/build.ts→tools/catalog/graph/index.ts→tools/catalog/index.ts→tools/database/mssql/export-tool.ts→tools/database/mssql/index.ts→tools/database/mssql/trace.ts→tools/index.ts",
    "note": "Barrel/sibling cycle debt — extract leaf module; allowlists must shrink"
  },
  {
    "pkg": "agent",
    "key": "core/doctrine.ts→core/doctrine/index.ts→core/doctrine/temp-naming.ts→tools/catalog-search/index.ts→tools/catalog-search/tool.ts→tools/catalog/graph/build.ts→tools/catalog/graph/index.ts→tools/catalog/index.ts→tools/database/mssql/export-tool.ts→tools/database/mssql/index.ts→tools/database/mssql/trace.ts→tools/index.ts",
    "note": "Barrel/sibling cycle debt — extract leaf module; allowlists must shrink"
  },
  {
    "pkg": "agent",
    "key": "core/doctrine.ts→core/doctrine/index.ts→core/doctrine/temp-scalar-subquery.ts→tools/catalog-search/index.ts→tools/catalog-search/tool.ts→tools/catalog/graph/build.ts→tools/catalog/graph/index.ts→tools/catalog/index.ts→tools/database/mssql/export-tool.ts→tools/database/mssql/index.ts→tools/database/mssql/trace.ts→tools/index.ts",
    "note": "Barrel/sibling cycle debt — extract leaf module; allowlists must shrink"
  },
  {
    "pkg": "agent",
    "key": "core/doctrine.ts→core/doctrine/index.ts→core/doctrine/wide-union-view-policy.ts→tools/catalog-search/index.ts→tools/catalog-search/tool.ts→tools/catalog/graph/build.ts→tools/catalog/graph/index.ts→tools/catalog/index.ts→tools/database/mssql/export-tool.ts→tools/database/mssql/index.ts→tools/database/mssql/trace.ts→tools/index.ts",
    "note": "Barrel/sibling cycle debt — extract leaf module; allowlists must shrink"
  },
  {
    "pkg": "agent",
    "key": "core/govern-tools.ts→core/govern-tools/govern-tool.ts→core/govern-tools/govern.ts→core/govern-tools/index.ts→tools/delegate-spawn/index.ts→tools/delegate-spawn/spawn-for-plan.ts→tools/index.ts",
    "note": "Barrel/sibling cycle debt — extract leaf module; allowlists must shrink"
  },
  {
    "pkg": "agent",
    "key": "core/plan/blueprint-contract/index.ts→core/plan/blueprint-contract/parse.ts",
    "note": "Barrel/sibling cycle debt — extract leaf module; allowlists must shrink"
  },
  {
    "pkg": "agent",
    "key": "core/plan/internal/index-remediate.ts→core/plan/normalize/index.ts",
    "note": "Barrel/sibling cycle debt — extract leaf module; allowlists must shrink"
  },
  {
    "pkg": "agent",
    "key": "core/plan/normalize/contract-injection.ts→core/plan/normalize/index.ts",
    "note": "Barrel/sibling cycle debt — extract leaf module; allowlists must shrink"
  },
  {
    "pkg": "agent",
    "key": "core/plan/pipeline-repair/blueprint.ts→core/plan/pipeline-repair/reconcile.ts",
    "note": "Barrel/sibling cycle debt — extract leaf module; allowlists must shrink"
  },
  {
    "pkg": "agent",
    "key": "core/recover.ts→core/recover/index.ts→core/recover/internal/build-advanced.ts→core/recover/internal/build-hints-advanced.ts→core/recover/internal/build-per-call-hints.ts→core/recover/recovery.ts→runtime/loop.ts→runtime/loop/index.ts→runtime/loop/post-round/index.ts→tools/catalog-search/index.ts→tools/catalog-search/tool.ts→tools/catalog/graph/build.ts→tools/catalog/graph/index.ts→tools/catalog/index.ts→tools/database/mssql/export-tool.ts→tools/database/mssql/index.ts→tools/index.ts",
    "note": "Barrel/sibling cycle debt — extract leaf module; allowlists must shrink"
  },
  {
    "pkg": "agent",
    "key": "core/recover.ts→core/recover/index.ts→core/recover/internal/build-hints-advanced.ts→core/recover/internal/build-per-call-hints.ts→core/recover/recovery.ts→runtime/loop.ts→runtime/loop/index.ts→runtime/loop/post-round/index.ts→tools/catalog-search/index.ts→tools/catalog-search/tool.ts→tools/catalog/graph/build.ts→tools/catalog/graph/index.ts→tools/catalog/index.ts→tools/database/mssql/export-tool.ts→tools/database/mssql/index.ts→tools/index.ts",
    "note": "Barrel/sibling cycle debt — extract leaf module; allowlists must shrink"
  },
  {
    "pkg": "agent",
    "key": "core/recover.ts→core/recover/index.ts→core/recover/internal/build-per-call-hints.ts→core/recover/recovery.ts→runtime/loop.ts→runtime/loop/index.ts→runtime/loop/post-round/index.ts→tools/catalog-search/index.ts→tools/catalog-search/tool.ts→tools/catalog/graph/build.ts→tools/catalog/graph/index.ts→tools/catalog/index.ts→tools/database/mssql/export-tool.ts→tools/database/mssql/index.ts→tools/index.ts",
    "note": "Barrel/sibling cycle debt — extract leaf module; allowlists must shrink"
  },
  {
    "pkg": "agent",
    "key": "core/recover.ts→core/recover/index.ts→core/recover/recovery.ts→runtime/loop.ts→runtime/loop/index.ts→runtime/loop/post-round/index.ts→tools/catalog-search/index.ts→tools/catalog-search/tool.ts→tools/catalog/graph/build.ts→tools/catalog/graph/index.ts→tools/catalog/index.ts→tools/database/mssql/export-tool.ts→tools/database/mssql/index.ts→tools/index.ts",
    "note": "Barrel/sibling cycle debt — extract leaf module; allowlists must shrink"
  },
  {
    "pkg": "server",
    "key": "infra/events/broadcaster.ts→infra/llm/copilot-chat.ts→infra/llm/env-override.ts→infra/llm/operation-context.ts→infra/llm/registry.ts→infra/persistence/connection.ts→infra/persistence/db/index.ts→infra/persistence/sqlite.ts",
    "note": "Barrel/sibling cycle debt — extract leaf module; allowlists must shrink"
  },
  {
    "pkg": "server",
    "key": "infra/persistence/attachments/agent-service.ts→infra/persistence/attachments/index.ts",
    "note": "Barrel/sibling cycle debt — extract leaf module; allowlists must shrink"
  },
  {
    "pkg": "server",
    "key": "infra/persistence/connection.ts→infra/persistence/db/index.ts→infra/persistence/memory/schema.ts→infra/persistence/sqlite.ts",
    "note": "Barrel/sibling cycle debt — extract leaf module; allowlists must shrink"
  },
  {
    "pkg": "server",
    "key": "infra/persistence/evidence/signer.ts→infra/persistence/evidence/signers/file-rsa.ts",
    "note": "Barrel/sibling cycle debt — extract leaf module; allowlists must shrink"
  },
  {
    "pkg": "server",
    "key": "infra/persistence/evidence/signer.ts→infra/persistence/evidence/signers/hmac.ts",
    "note": "Barrel/sibling cycle debt — extract leaf module; allowlists must shrink"
  },
  {
    "pkg": "server",
    "key": "infra/persistence/evidence/signer.ts→infra/persistence/evidence/signers/kms-stub.ts",
    "note": "Barrel/sibling cycle debt — extract leaf module; allowlists must shrink"
  },
  {
    "pkg": "server",
    "key": "infra/sandbox/backend.ts→infra/sandbox/index.ts",
    "note": "Barrel/sibling cycle debt — extract leaf module; allowlists must shrink"
  },
  {
    "pkg": "agent",
    "key": "memory/context-management/index.ts→memory/context-truncation.ts",
    "note": "Barrel/sibling cycle debt — extract leaf module; allowlists must shrink"
  },
  {
    "pkg": "agent",
    "key": "runtime/loop.ts→runtime/loop/index.ts→runtime/loop/post-round/index.ts→tools/catalog-search/index.ts→tools/catalog-search/tool.ts→tools/catalog/graph/build.ts→tools/catalog/graph/index.ts→tools/catalog/index.ts→tools/database/mssql/export-tool.ts→tools/database/mssql/index.ts→tools/index.ts",
    "note": "Barrel/sibling cycle debt — extract leaf module; allowlists must shrink"
  },
  {
    "pkg": "agent",
    "key": "runtime/loop.ts→runtime/loop/index.ts→runtime/loop/prompt-vars.ts→tools/catalog-search/index.ts→tools/catalog-search/tool.ts→tools/catalog/graph/build.ts→tools/catalog/graph/index.ts→tools/catalog/index.ts→tools/database/mssql/export-tool.ts→tools/database/mssql/index.ts→tools/index.ts",
    "note": "Barrel/sibling cycle debt — extract leaf module; allowlists must shrink"
  },
  {
    "pkg": "agent",
    "key": "runtime/loop.ts→runtime/loop/index.ts→runtime/loop/tool-execution/artifact-tracking.ts→runtime/loop/tool-execution/index.ts→tools/catalog-search/index.ts→tools/catalog-search/tool.ts→tools/catalog/graph/build.ts→tools/catalog/graph/index.ts→tools/catalog/index.ts→tools/database/mssql/export-tool.ts→tools/database/mssql/index.ts→tools/index.ts",
    "note": "Barrel/sibling cycle debt — extract leaf module; allowlists must shrink"
  },
  {
    "pkg": "agent",
    "key": "runtime/loop.ts→runtime/loop/index.ts→runtime/loop/tool-execution/index.ts→runtime/loop/tool-execution/kill-manager.ts→tools/catalog-search/index.ts→tools/catalog-search/tool.ts→tools/catalog/graph/build.ts→tools/catalog/graph/index.ts→tools/catalog/index.ts→tools/database/mssql/export-tool.ts→tools/database/mssql/index.ts→tools/index.ts",
    "note": "Barrel/sibling cycle debt — extract leaf module; allowlists must shrink"
  },
  {
    "pkg": "agent",
    "key": "runtime/loop.ts→runtime/loop/index.ts→runtime/loop/tool-execution/index.ts→tools/catalog-search/index.ts→tools/catalog-search/tool.ts→tools/catalog/graph/build.ts→tools/catalog/graph/index.ts→tools/catalog/index.ts→tools/database/mssql/export-tool.ts→tools/database/mssql/index.ts→tools/index.ts",
    "note": "Barrel/sibling cycle debt — extract leaf module; allowlists must shrink"
  },
  {
    "pkg": "agent",
    "key": "tools/catalog/graph/build.ts→tools/catalog/graph/index.ts→tools/catalog/index.ts→tools/database/mssql/export-tool.ts→tools/database/mssql/index.ts",
    "note": "Barrel/sibling cycle debt — extract leaf module; allowlists must shrink"
  },
  {
    "pkg": "agent",
    "key": "tools/catalog/graph/build.ts→tools/catalog/graph/index.ts→tools/catalog/index.ts→tools/database/mssql/index.ts→tools/database/mssql/tools.ts",
    "note": "Barrel/sibling cycle debt — extract leaf module; allowlists must shrink"
  },
  {
    "pkg": "agent",
    "key": "tools/catalog/graph/build.ts→tools/catalog/graph/index.ts→tools/catalog/store.ts→tools/database/mssql/error-hints.ts→tools/database/mssql/export-tool.ts→tools/database/mssql/index.ts",
    "note": "Barrel/sibling cycle debt — extract leaf module; allowlists must shrink"
  }
]
