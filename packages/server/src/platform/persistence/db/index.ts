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
  listRunsWithUsageForThread,
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
  countSyncDefinitionConfigs,
  countSyncEnvironments,
  deleteLayout,
  deletePolicyRule,
  deleteSyncDefinitionConfig,
  deleteSyncEnvironment,
  deleteSyncEnvOverride,
  getLayout,
  getLayouts,
  getSyncDefinitionConfig,
  getSyncEnvironment,
  getSyncEnvOverride,
  listPolicyRules,
  listSyncDefinitionConfigs,
  listSyncEnvironments,
  listSyncEnvOverrides,
  PolicySource,
  saveLayout,
  savePolicyRule,
  saveSyncDefinitionConfig,
  saveSyncEnvironment,
  saveSyncEnvOverride,
  seedPolicyRuleIfMissing,
  type DbLayout,
  type DbPolicyRule,
  type DbSyncDefinitionConfig,
  type DbSyncEnvironment,
  type DbSyncEnvOverride
} from "./config.js"

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
} from "./agents.js"

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
  deleteWebhookDrain,
  getWebhookDrain,
  listEvents,
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
  deleteSyncRunKind,
  deleteSyncRunPhase,
  deleteSyncRunPreset,
  getSyncRunPreset,
  listSyncRunKinds,
  listSyncRunPhases,
  listSyncRunPresets,
  mapKindDefinition,
  mapPhaseDefinition,
  parsePresetSteps,
  saveSyncRunKind,
  saveSyncRunPhase,
  saveSyncRunPreset,
  syncRunCatalogEmpty,
  syncBuiltInFlowPresetsFromArtifact,
  serializeBuiltInFlowStepsFromArtifact,
  syncDeploySyncMetadataFromArtifact,
  type DbSyncRunKind,
  type DbSyncRunPhase,
  type DbSyncRunPreset
} from "./sync-run-catalog.js"

export {
  deleteSyncRunBindingSource,
  listSyncRunBindingSources,
  mapCustomValueSourceDefinition,
  saveSyncRunBindingSource,
  type DbSyncRunBindingSource,
} from "./sync-run-binding-sources.js"

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
