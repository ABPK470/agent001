/**
 * Database barrel — re-exports all persistence modules.
 *
 * All existing `import { ... } from "./db.js"` statements continue working.
 * Internally, persistence is split into domain-specific modules under db/.
 */

// Connection (singleton + testing hook)
export { _setDb, getDb } from "./db/connection.js"

// Internal migration export for testing
export { _migrate } from "./db/connection.js"

// Runs, audit, checkpoints, logs, traces, token usage
export {
    findStaleRuns, getAuditLog, getCheckpoint, getLogs, getRun, getTokenUsage, getTraceEntries, getUsageTotals, listRuns,
    listRunsWithUsage,
    listRunsWithUsageForUser, listTokenUsage, markRunCrashed, saveAudit, saveCheckpoint, saveLog, saveRun, saveTokenUsage, saveTraceEntry, type DbAudit, type DbCheckpoint, type DbLog, type DbRun,
    type DbRunWithUsage, type DbTokenUsage, type DbTraceEntry, type UsageTotals
} from "./db/runs.js"

// Layouts & policies
export {
    deleteLayout, deletePolicyRule, getLayout, getLayouts, listPolicyRules, saveLayout, savePolicyRule, type DbLayout, type DbPolicyRule
} from "./db/config.js"

// LLM config & agent definitions
export {
    deleteAgentDefinition, getAgentDefinition, getLlmConfig, listAgentDefinitions, saveAgentDefinition, saveLlmConfig,
    type DbAgentDefinition, type DbLlmConfig, type LlmProvider
} from "./db/agents.js"

// Notifications
export {
    getNotification, getUnreadNotificationCount, getUnreadNotificationCountForUser, listNotifications, listNotificationsForUser, markAllNotificationsRead, markNotificationRead, migrateNotifications,
    saveNotification, type DbNotification
} from "./db/notifications.js"

// API request logging
export {
    listApiRequests, migrateApiRequests,
    saveApiRequest, type DbApiRequest
} from "./db/api-requests.js"

// Event log & webhook drains
export {
    deleteWebhookDrain, getWebhookDrain, listEvents, listWebhookDrains, migrateEventLog, migrateWebhookDrains, saveEvent, saveWebhookDrain, type DbEvent, type DbWebhookDrain
} from "./db/events.js"

// Data lifecycle — reset, pruning, stats
export {
    clearTransactionalData, getDbStats, pruneOldData
} from "./db/lifecycle.js"

