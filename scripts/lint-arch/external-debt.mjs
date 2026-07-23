/** Shrinking External Leverage debt — silent failure + trust escapes. Do not grow casually.
 * Seeded from AST with empty allowlist. Burn down; unused entries fail.
 */
export const SILENT_FAILURE_ALLOWLIST = [
  {
    "file": "agent/core/plan/generate/normalize.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "agent/core/plan/internal/verifier-io.ts",
    "note": "9 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "agent/core/plan/internal/verifier-probes-subprobes.ts",
    "note": "4 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "agent/core/plan/pipeline-validation/index.ts",
    "note": "2 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "agent/core/plan/platform-errors.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "agent/core/plan/verifier-integration/helpers.ts",
    "note": "2 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "agent/core/plan/verifier-integration/probes/signatures.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "agent/core/plan/verifier/index.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "agent/llm/databricks.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "agent/memory/prompt-budget/index.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "agent/runtime/loop/loop-policy/completion.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "agent/runtime/loop/system-prompt.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "agent/tools/_tool-cache.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "agent/tools/catalog/graph/build.ts",
    "note": "2 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "agent/tools/catalog/store.ts",
    "note": "2 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "agent/tools/database/mssql/connection.ts",
    "note": "2 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "agent/tools/database/mssql/export-tool.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "agent/tools/database/mssql/tools.ts",
    "note": "2 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "agent/tools/delegate-spawn/spawn-for-plan.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "agent/tools/files/filesystem/write-execute.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "agent/tools/files/search-files.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "server/api/auth/state/identity.ts",
    "note": "2 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "server/api/connectors/state/live-connectors.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "server/api/connectors/state/mssql-pool-provider.ts",
    "note": "3 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "server/api/notifications/adapters/email.ts",
    "note": "2 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "server/api/notifications/service/delivery-routing.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "server/api/runs/execution/clarifications-learned.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "server/api/runs/execution/run-executor/agent.ts",
    "note": "3 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "server/api/runs/execution/run-executor/host.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "server/api/runs/execution/run-executor/tools.ts",
    "note": "3 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "server/api/runs/orchestrator.ts",
    "note": "2 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "server/api/runs/prompting/coordination/planner-events.ts",
    "note": "8 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "server/api/runs/prompting/data-blocks/resolved-facts-block.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "server/api/runs/routes.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "server/api/runs/run-artifacts.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "server/api/runs/tooling/registry.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "server/api/runs/workspace/index.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "server/boot/shutdown.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "server/http/build-app.ts",
    "note": "5 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "server/infra/effects/rollback.ts",
    "note": "2 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "server/infra/effects/tracker.ts",
    "note": "2 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "server/infra/events/broadcaster.ts",
    "note": "5 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "server/infra/llm/copilot-chat.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "server/infra/persistence/db/events.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "server/infra/persistence/db/lifecycle.ts",
    "note": "2 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "server/infra/persistence/db/tool-results.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "server/infra/persistence/memory/ingestion.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "server/infra/persistence/memory/resolved-terms.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "server/infra/persistence/memory/schema.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "server/infra/persistence/memory/tool-knowledge.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "server/infra/persistence/tool-cache.ts",
    "note": "6 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "server/infra/queue/channels/teams.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "server/infra/sandbox/backend.ts",
    "note": "4 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "server/infra/sandbox/docker-sandbox.ts",
    "note": "4 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "sync/runtime/orchestrator/execute.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "sync/runtime/orchestrator/metadata-sync.ts",
    "note": "2 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "sync/runtime/plan-store.ts",
    "note": "6 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "sync/test-support/sync-test-host.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/app/App.tsx",
    "note": "9 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/app/TransitionTestPage.tsx",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/app/workspace/layout/persistence.ts",
    "note": "4 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/app/workspace/WidgetFrame.tsx",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/app/workspace/WidgetShell.tsx",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/client/index.ts",
    "note": "3 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/components/CodeBlock.tsx",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/components/JsonViewer.tsx",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/components/SmartAnswer.tsx",
    "note": "2 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/hooks/useEventStreamData.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/hooks/useMe.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/hooks/useOperationLogData.ts",
    "note": "3 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/hooks/useTheme.ts",
    "note": "2 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/hooks/useViewTabReorder.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/lib/events/build-chat-parts.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/lib/userDownload.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/state/store.ts",
    "note": "3 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/widgets/AgentChat.tsx",
    "note": "2 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/widgets/bridge/BridgeShell.tsx",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/widgets/chat/composerDraftStorage.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/widgets/chat/useChatSlashActions.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/widgets/entity-registry/EntityEditModal.tsx",
    "note": "2 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/widgets/entity-registry/sync-environments/SyncEnvironmentForm.tsx",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/widgets/entity-registry/SyncMetadataModal.tsx",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/widgets/env-sync/EnvSyncWidget.tsx",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/widgets/env-sync/exec-store.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/widgets/env-sync/HistoryContent.tsx",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/widgets/MymiDb.tsx",
    "note": "5 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/widgets/OperationLog.tsx",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/widgets/platform/ApprovalRequiredModal.tsx",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/widgets/platform/AuditModal.tsx",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/widgets/platform/NotificationPanel.tsx",
    "note": "11 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/widgets/platform/PlatformHealthBanner.tsx",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/widgets/platform/policy/SelectorRulesTab.tsx",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/widgets/platform/PolicyEditor.tsx",
    "note": "2 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/widgets/platform/UsageModal.tsx",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/widgets/RunHistory.tsx",
    "note": "4 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/widgets/RunStatus.tsx",
    "note": "2 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/widgets/sync-admin/useProposerScanState.ts",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/widgets/TermChat.tsx",
    "note": "4 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/widgets/threads/DeleteThreadModal.tsx",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/widgets/threads/ThreadRowMenu.tsx",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/widgets/threads/ThreadSidebar.tsx",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  },
  {
    "file": "ui/widgets/trace/TraceCopy.tsx",
    "note": "1 silent failure site(s) — named handling / user-visible error; allowlists must shrink"
  }
]

export const TRUST_ALLOWLIST = []

export const ENUM_FORK_ALLOWLIST = []

export const JARGON_ALLOWLIST = []
