/**
 * Database barrel — re-exports all persistence modules.
 *
 * All existing `import { ... } from "./db/index.js"` statements continue working.
 * Internally, persistence is split into domain-specific modules under db/.
 */

// Connection (singleton + testing hook)
export { _setDb, getDb, getDbPath } from "./connection.js"

// Internal migration export for testing
export { _migrate } from "./connection.js"

// Runs, audit, checkpoints, logs, traces, token usage
export {
    dbRunToWire, findStaleRuns, getAuditLog, getCheckpoint, getLogs, getRun, getTokenUsage, getTraceEntries, getUsageTotals, listRuns,
    listRunsWithUsage,
    listRunsWithUsageForUser, listTokenUsage, markRunCancelled, markRunCrashed, normaliseUnknownRunStatuses, saveAdminAudit, saveAudit, saveCheckpoint, saveLog, saveRun, saveTokenUsage, saveTraceEntry, type AuditScopeType, type DbAudit, type DbCheckpoint, type DbLog, type DbRun,
    type DbRunWithUsage, type DbTokenUsage, type DbTraceEntry, type RunWireExtras, type UsageTotals
} from "./runs.js"

// Layouts & policies
export {
    deleteLayout, deletePolicyRule, deleteSyncEnvOverride, getLayout, getLayouts, getSyncEnvOverride, listPolicyRules,
    listSyncEnvOverrides, PolicySource, saveLayout, savePolicyRule, saveSyncEnvOverride, seedPolicyRuleIfMissing,
    type DbLayout, type DbPolicyRule, type DbSyncEnvOverride
} from "./config.js"

// LLM config & agent definitions
export {
    deleteAgentDefinition, getAgentDefinition, getLlmConfig, listAgentDefinitions, saveAgentDefinition, saveLlmConfig,
    type DbAgentDefinition, type DbLlmConfig, type LlmProvider
} from "./agents.js"

// Notifications
export {
    getNotification, getUnreadNotificationCount, getUnreadNotificationCountForUser, listNotifications, listNotificationsForUser, markAllNotificationsRead, markNotificationRead, migrateNotifications,
    saveNotification, type DbNotification
} from "./notifications.js"

// API request logging
export {
    listApiRequests, migrateApiRequests,
    saveApiRequest, type DbApiRequest
} from "./api-requests.js"

// Event log & webhook drains
export {
    deleteWebhookDrain, getWebhookDrain, listEvents, listWebhookDrains, migrateEventLog, migrateWebhookDrains, saveEvent, saveWebhookDrain, type DbEvent, type DbWebhookDrain
} from "./events.js"

// Data lifecycle — reset, pruning, stats
export {
    clearTransactionalData, getDbStats, pruneOldData
} from "./lifecycle.js"

// Sync runs (ABI environment sync history)
export {
    getSyncRun, getSyncRunPlanJson, listSyncRuns, recordSyncRunFinish, recordSyncRunPreview, recordSyncRunStart, type SyncRunRow
} from "./sync-runs.js"

// Sync audit (sync-scoped audit trail; replaces the audit_log 'sync:<planId>' hack)
export {
    listRecentSyncAudit, listSyncAuditForPlan, recordSyncAudit, type SyncAuditRow
} from "./sync-audit.js"

// Entity registry (Phase 0 config uplift — versioned entity defs + SCD2 strategies)
export {
    EntityRegistryValidationError, getEntityDefinition, listAvailableStrategies, listEntityDefinitionHistory, listEntityDefinitions, readEntityVersionBody, resolveScd2Strategy, retireEntityDefinition, saveEntityDefinition, saveScd2Strategy, type EntityDefinitionHistoryEntry, type EntityDefinitionRecord, type EntityDefinitionVersionRow, type SaveEntityResult, type SaveStrategyResult
} from "./entity-defs.js"

// F1 — Reconciliation proposer
export {
    countProposalsByStatus, createProposerRun, finishProposerRun, getProposal,
    getProposerRun, ingestFindings, listProposalHistory, listProposals,
    listProposerRuns, markProposerRunRunning, parseAnnotation, parseCounts,
    saveAnnotation, saveRankScore, updateProposalStatus,
    type ProposalHistoryRow, type ProposalRow, type ProposerRunRow
} from "./proposals.js"

// F1 — Approval workflow
export {
    ApprovalError, ApprovalPolicyKind, ApprovalState, bypassApproval,
    consumeApprovalToken, createApproval, expireDueApprovals, findActiveApprovalForProposal,
    getApproval, getApprovalPolicy, grantApproval, issueApprovalToken,
    listApprovalPolicies, rejectApproval, upsertApprovalPolicy,
    type ApprovalPolicy, type ApprovalRow, type ConsumedToken, type IssuedToken
} from "./approvals.js"

// Freeze windows (governance — referenced from EntityPolicies.freezeWindowIds[])
export {
    deleteFreezeWindow, FreezeWindowValidationError, getFreezeWindow,
    listFreezeWindowsForTenant, refreshFreezeWindowRegistry, upsertFreezeWindow,
    type FreezeWindowRecord, type UpsertFreezeWindowArgs
} from "./freeze-windows.js"

