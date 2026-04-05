/**
 * Database barrel — re-exports all persistence modules.
 *
 * All existing `import { ... } from "./db.js"` statements continue working.
 * Internally, persistence is split into domain-specific modules under db/.
 */

// Connection (singleton + testing hook)
export { getDb, _setDb } from "./db/connection.js"

// Internal migration export for testing
export { _migrate } from "./db/connection.js"

// Runs, audit, checkpoints, logs, traces, token usage
export {
  type DbRun,
  type DbRunWithUsage,
  saveRun,
  getRun,
  listRuns,
  listRunsWithUsage,
  findStaleRuns,
  markRunCrashed,
  type DbAudit,
  saveAudit,
  getAuditLog,
  type DbCheckpoint,
  saveCheckpoint,
  getCheckpoint,
  type DbLog,
  saveLog,
  getLogs,
  type DbTraceEntry,
  saveTraceEntry,
  getTraceEntries,
  type DbTokenUsage,
  saveTokenUsage,
  getTokenUsage,
  listTokenUsage,
  type UsageTotals,
  getUsageTotals,
} from "./db/runs.js"

// Layouts & policies
export {
  type DbLayout,
  saveLayout,
  getLayouts,
  getLayout,
  deleteLayout,
  type DbPolicyRule,
  listPolicyRules,
  savePolicyRule,
  deletePolicyRule,
} from "./db/config.js"

// LLM config & agent definitions
export {
  type LlmProvider,
  type DbLlmConfig,
  getLlmConfig,
  saveLlmConfig,
  type DbAgentDefinition,
  listAgentDefinitions,
  getAgentDefinition,
  saveAgentDefinition,
  deleteAgentDefinition,
} from "./db/agents.js"

// Notifications
export {
  type DbNotification,
  migrateNotifications,
  saveNotification,
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  getUnreadNotificationCount,
} from "./db/notifications.js"

// API request logging
export {
  type DbApiRequest,
  migrateApiRequests,
  saveApiRequest,
  listApiRequests,
} from "./db/api-requests.js"

// Event log & webhook drains
export {
  type DbEvent,
  migrateEventLog,
  saveEvent,
  listEvents,
  type DbWebhookDrain,
  migrateWebhookDrains,
  listWebhookDrains,
  getWebhookDrain,
  saveWebhookDrain,
  deleteWebhookDrain,
} from "./db/events.js"

// Data lifecycle — reset, pruning, stats
export {
  clearTransactionalData,
  pruneOldData,
  getDbStats,
} from "./db/lifecycle.js"
