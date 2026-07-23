export { _migrate, _setDb, getDb, getDbPath, openDatabase } from "../connection.js"

export {
  findReplyTo,
  insertAgentMessage,
  listAgentMessages,
  type AgentMessageRow,
  type InsertMessageInput
} from "./agent-messages.js"

export {
  autoTitleThreadFromGoal,
  createThread,
  dbThreadToWire,
  deleteThreadAndRuns,
  getThread,
  listRunIdsForThread,
  listThreadsForUser,
  touchThread,
  updateThread,
  type DbThread,
  type DbThreadWithRunCount
} from "./threads.js"

export {
  countAuditLog,
  dbRunToWire,
  findStaleRuns,
  getAuditLog,
  getCheckpoint,
  getLogs,
  getRun,
  getTokenUsage,
  getTraceEntries,
  getUsageTotals,
  getUsageTotalsForUser,
  countTokenUsage,
  listAuditFilterOptions,
  listAuditLogPaginated,
  listRuns,
  listRunsWithUsage,
  listRunsWithUsageForThread,
  listRunsWithUsageForUser,
  listTokenUsage,
  listTokenUsageFilterOptions,
  listTokenUsagePaginated,
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
  sumTokenUsage,
  type AuditLogFilters,
  type AuditLogSort,
  type AuditScopeType,
  type DbAudit,
  type DbAuditWithRun,
  type DbCheckpoint,
  type DbLog,
  type DbRun,
  type DbRunWithUsage,
  type DbTokenUsage,
  type DbTokenUsageWithRun,
  type DbTraceEntry,
  type ListAuditLogPaginatedInput,
  type ListTokenUsagePaginatedInput,
  type RunWireExtras,
  type TokenUsageFilters,
  type TokenUsageSort,
  type UsageTotals
} from "./runs.js"

export {
  extractToolResultText,
  getToolResult,
  isRecallableToolResult,
  isRecallableToolText,
  loadRecentToolResultsForThread,
  loadToolResultsForRun,
  saveToolResult,
  type DbToolResult
} from "./tool-results.js"

export {
  countSyncEnvironments,
  deleteLayout,
  deletePolicyRule,
  deleteSyncEnvironment,
  deleteSyncEnvOverride,
  getLayout,
  getLayouts,
  getSyncEnvironment,
  getSyncEnvOverride,
  listPolicyRules,
  listSyncEnvironments,
  listSyncEnvOverrides,
  PolicySource,
  saveLayout,
  savePolicyRule,
  saveSyncEnvironment,
  saveSyncEnvOverride,
  seedPolicyRuleIfMissing,
  type DbLayout,
  type DbPolicyRule,
  type DbSyncEnvironment,
  type DbSyncEnvOverride
} from "./config.js"

export {
  getLlmConfig,
  saveLlmConfig,
  type DbLlmConfig,
  type LlmProvider
} from "./llm-config.js"

export {
  getNotification,
  getUnreadNotificationCount,
  getUnreadNotificationCountForUser,
  listNotifications,
  listNotificationsForUser,
  markAllNotificationsRead,
  markNotificationRead,
  saveNotification,
  type DbNotification
} from "./notifications.js"

export { listApiRequests, saveApiRequest, type DbApiRequest } from "./api-requests.js"

export {
  countConnectors,
  deleteConnector,
  getConnector,
  listConnectors,
  saveConnector,
  type DbConnector,
} from "./connectors.js"

export {
  deleteWebhookDrain,
  getWebhookDrain,
  listEvents,
  listEventsForPlanId,
  listEventsForRunId,
  listWebhookDrains,
  saveEvent,
  saveWebhookDrain,
  searchEvents,
  type DbEvent,
  type DbWebhookDrain
} from "./events.js"

export { clearTransactionalData, getDbStats, pruneOldData } from "./lifecycle.js"

export {
  countSyncRuns,
  getSyncRun,
  getSyncRunPlanJson,
  listSyncRuns,
  listSyncRunsPaginated,
  recordSyncRunFinish,
  recordSyncRunPreview,
  recordSyncRunStart,
  type ListSyncRunsPaginatedInput,
  type SyncRunRow
} from "./sync-runs.js"

export {
  countSyncSqlLogByPlan,
  enrichSyncSqlEventData,
  getSyncSqlLog,
  hydratePersistedSqlEventData,
  listSyncSqlLogByPlan,
  recordSyncSqlLog,
  stripInternalSqlFields,
  type SyncSqlLogRow
} from "./sync-sql-log.js"

export {
  listRecentSyncAudit,
  listSyncAuditForPlan,
  recordSyncAudit,
  type SyncAuditRow
} from "./sync-audit.js"

export {
  EntityRegistryConflictError,
  EntityRegistryValidationError,
  getEntityDefinition,
  listAvailableStrategies,
  listScd2StrategyHistory,
  listEntityDefinitionHistory,
  listEntityDefinitions,
  readEntityVersionBody,
  resolveScd2Strategy,
  retireEntityDefinition,
  retireScd2Strategy,
  saveEntityDefinition,
  saveScd2Strategy,
  wipeEntityRegistry,
  type EntityDefinitionHistoryEntry,
  type EntityDefinitionRecord,
  type EntityDefinitionVersionRow,
  type SaveEntityResult,
  type SaveStrategyResult,
  type Scd2StrategyHistoryEntry
} from "./entity-registry.js"

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
  deleteApprovalPolicy,
  rejectApproval,
  upsertApprovalPolicy,
  type ApprovalPolicy,
  type ApprovalRow,
  type ConsumedToken,
  type IssuedToken
} from "./approvals.js"

export {
  deleteFreezeWindow,
  FreezeWindowValidationError,
  getFreezeWindow,
  listFreezeWindowDefinitionsForTenant,
  listFreezeWindowsForTenant,
  refreshFreezeWindowRegistry,
  upsertFreezeWindow,
  type FreezeWindowRecord,
  type UpsertFreezeWindowArgs
} from "./freeze-windows.js"

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
  deleteSyncAction,
  deleteSyncFlow,
  deleteSyncPhase,
  getSyncFlow,
  listSyncActions,
  listSyncFlows,
  listSyncPhases,
  mapKindDefinition,
  mapPhaseDefinition,
  parseFlowSteps,
  saveSyncAction,
  saveSyncFlow,
  saveSyncPhase,
  syncCatalogEmpty,
  syncBuiltInFlowsFromArtifact,
  serializeBuiltInFlowStepsFromArtifact,
  syncDeploySyncMetadataFromArtifact,
  type DbSyncAction,
  type DbSyncFlow,
  type DbSyncPhase,
} from "./sync-run-catalog.js"

export {
  deleteSyncValueSource,
  listSyncValueSources,
  mapValueSourceDefinition,
  saveSyncValueSource,
  type DbSyncValueSource,
} from "./sync-value-sources.js"

export {
  getSyncDefinition,
  getSyncPublishMeta,
  listSyncDefinitions,
  loadPublishedBundleFromDb,
  replaceSyncDefinitions,
  saveSyncPublishMeta,
  type DbSyncDefinitionRow,
  type DbSyncPublishMeta,
  type PublishedBundleFromDb,
} from "./sync-definitions.js"

export {
  appendSyncCatalogVersion,
  countSyncCatalogVersions,
  getActiveSyncCatalogVersion,
  getSyncCatalogVersionRow,
  listSyncCatalogVersionSummaries,
  type DbSyncCatalogVersion,
  type SyncCatalogVersionSummary,
} from "./sync-catalog-versions.js"

export {
  consumeRunToolApprovalGrant,
  getPendingRunToolApproval,
  getRunToolApproval,
  listApprovedToolGrantsForRuns,
  listPendingRunToolApprovalsForRuns,
  markRunToolApprovalApproved,
  markRunToolApprovalDenied,
  markRunWaitingForApproval,
  upsertPendingRunToolApproval,
  type RunToolApprovalRecord,
  type RunToolApprovalStatus,
} from "./run-tool-approvals.js"

export {
  consumeSyncToolApprovalGrant,
  ensureSyncToolApprovalsTable,
  getSyncToolApproval,
  listApprovedSyncToolGrants,
  markSyncToolApprovalApproved,
  markSyncToolApprovalDenied,
  syncToolArgsKey,
  upsertPendingSyncToolApproval,
  type SyncToolApprovalRecord,
  type SyncToolApprovalStatus,
} from "./sync-tool-approvals.js"

export {
  countAdmins,
  countUsers,
  findUserByUpn,
  findUserByUsername,
  insertUser,
  listUsers,
  setUserAdmin,
  updateLastLoginAt,
  type DbUser,
  type InsertUserInput
} from "./users.js"
