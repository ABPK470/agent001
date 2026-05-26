/**
 * SQLite-backed durable state entrypoint.
 */

export { _migrate, _setDb, getDb, getDbPath, migrateSessionFkSetNull } from "./db-connection.js"

export {
    findReplyTo,
    insertAgentMessage,
    listAgentMessages,
    type AgentMessageRow,
    type InsertMessageInput
} from "../../db/agent-messages.js"

export {
    dbRunToWire,
    findStaleRuns,
    getAuditLog,
    getCheckpoint,
    getLogs,
    getRun,
    getTokenUsage,
    getTraceEntries,
    getUsageTotals,
    listRuns,
    listRunsWithUsage,
    listRunsWithUsageForUser,
    listTokenUsage,
    markRunCancelled,
    markRunCrashed,
    normaliseUnknownRunStatuses,
    saveAdminAudit,
    saveAudit,
    saveCheckpoint,
    saveLog,
    saveRun,
    saveTokenUsage,
    saveTraceEntry,
    type AuditScopeType,
    type DbAudit,
    type DbCheckpoint,
    type DbLog,
    type DbRun,
    type DbRunWithUsage,
    type DbTokenUsage,
    type DbTraceEntry,
    type RunWireExtras,
    type UsageTotals
} from "../../db/runs.js"

export {
    extractToolResultText, getToolResult,
    isRecallableToolResult,
    isRecallableToolText,
    loadRecentToolResults,
    loadToolResultsForRun,
    saveToolResult, type DbToolResult
} from "./tool-results.js"

export {
    deleteLayout,
    deletePolicyRule,
    deleteSyncEnvOverride,
    getLayout,
    getLayouts,
    getSyncEnvOverride,
    listPolicyRules,
    listSyncEnvOverrides,
    PolicySource,
    saveLayout,
    savePolicyRule,
    saveSyncEnvOverride,
    seedPolicyRuleIfMissing,
    type DbLayout,
    type DbPolicyRule,
    type DbSyncEnvOverride
} from "../../db/config.js"

export {
    deleteAgentDefinition,
    getAgentDefinition,
    getLlmConfig,
    listAgentDefinitions,
    resolveAgentSystemPrompt,
    saveAgentDefinition,
    saveLlmConfig,
    type DbAgentDefinition,
    type DbLlmConfig,
    type LlmProvider
} from "../../db/agents.js"

export {
    getNotification,
    getUnreadNotificationCount,
    getUnreadNotificationCountForUser,
    listNotifications,
    listNotificationsForUser,
    markAllNotificationsRead,
    markNotificationRead,
    migrateNotifications,
    saveNotification,
    type DbNotification
} from "../../db/notifications.js"

export {
    listApiRequests,
    migrateApiRequests,
    saveApiRequest,
    type DbApiRequest
} from "../../db/api-requests.js"

export {
    deleteWebhookDrain,
    getWebhookDrain,
    listEvents,
    listWebhookDrains,
    migrateEventLog,
    migrateWebhookDrains,
    saveEvent,
    saveWebhookDrain,
    searchEvents,
    type DbEvent,
    type DbWebhookDrain
} from "./events.js"

export {
    clearTransactionalData,
    getDbStats,
    pruneOldData
} from "../../db/lifecycle.js"

export {
    getSyncRun,
    getSyncRunPlanJson,
    listSyncRuns,
    recordSyncRunFinish,
    recordSyncRunPreview,
    recordSyncRunStart,
    type SyncRunRow
} from "../../db/sync-runs.js"

export {
    listRecentSyncAudit,
    listSyncAuditForPlan,
    recordSyncAudit,
    type SyncAuditRow
} from "../../db/sync-audit.js"

export {
    EntityRegistryValidationError,
    getEntityDefinition,
    listAvailableStrategies,
    listEntityDefinitionHistory,
    listEntityDefinitions,
    readEntityVersionBody,
    resolveScd2Strategy,
    retireEntityDefinition,
    saveEntityDefinition,
    saveScd2Strategy,
    type EntityDefinitionHistoryEntry,
    type EntityDefinitionRecord,
    type EntityDefinitionVersionRow,
    type SaveEntityResult,
    type SaveStrategyResult
} from "./entity-defs.js"

export {
    countProposalsByStatus,
    createProposerRun,
    finishProposerRun,
    getProposal,
    getProposerRun,
    ingestFindings,
    listProposalHistory,
    listProposals,
    listProposerRuns,
    markProposerRunRunning,
    parseAnnotation,
    parseCounts,
    saveAnnotation,
    saveRankScore,
    updateProposalStatus,
    type ProposalHistoryRow,
    type ProposalRow,
    type ProposerRunRow
} from "./proposals.js"

export {
    ApprovalError,
    ApprovalPolicyKind,
    ApprovalState,
    bypassApproval,
    consumeApprovalToken,
    createApproval,
    expireDueApprovals,
    findActiveApprovalForProposal,
    getApproval,
    getApprovalPolicy,
    grantApproval,
    issueApprovalToken,
    listApprovalPolicies,
    rejectApproval,
    upsertApprovalPolicy,
    type ApprovalPolicy,
    type ApprovalRow,
    type ConsumedToken,
    type IssuedToken
} from "../../db/approvals.js"

export {
    deleteFreezeWindow,
    FreezeWindowValidationError,
    getFreezeWindow,
    listFreezeWindowDefinitionsForTenant,
    listFreezeWindowsForTenant,
    upsertFreezeWindow,
    type FreezeWindowRecord,
    type UpsertFreezeWindowArgs
} from "../../db/freeze-windows.js"

export {
    createSession,
    deleteSession,
    deleteSessionsForUser,
    getSession,
    getSessionWithUser,
    listSessions,
    listUserHistory,
    listUsersWithStats,
    touchSession,
    type DbSession,
    type SessionWithUser
} from "./sessions.js"

export {
    countUsers,
    findUserByUpn,
    findUserByUsername,
    insertUser,
    listUsers, updateLastLoginAt as setLastLogin, updateLastLoginAt,
    type DbUser,
    type InsertUserInput
} from "./users.js"

