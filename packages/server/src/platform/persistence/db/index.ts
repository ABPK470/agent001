export { _migrate, _setDb, getDb, getDbPath } from "./connection.js"

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
  getThread,
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
  getSyncRun,
  getSyncRunPlanJson,
  listSyncRuns,
  recordSyncRunFinish,
  recordSyncRunPreview,
  recordSyncRunStart,
  type SyncRunRow
} from "./sync-runs.js"

export {
  listRecentSyncAudit,
  listSyncAuditForPlan,
  recordSyncAudit,
  type SyncAuditRow
} from "./sync-audit.js"

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
  countUsers,
  findUserByUpn,
  findUserByUsername,
  insertUser,
  listUsers,
  updateLastLoginAt,
  type DbUser,
  type InsertUserInput
} from "./users.js"
