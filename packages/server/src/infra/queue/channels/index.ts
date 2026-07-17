/**
 * Channel package barrel export.
 */

// Types
export type {
  Channel,
  ChannelConfig,
  ChannelType,
  Conversation,
  DeliveryStatus,
  InboundMessage,
  OutboundMessage,
  RetryPolicy
} from "./types.js"

// Channels
export { TeamsChannel } from "./teams.js"
export type { TeamsConversationRef } from "./teams.js"

// Queue + retry
export { MessageQueue } from "./queue.js"
export type { QueueStore } from "./queue.js"
export { ChannelApiError, computeDelay, DEFAULT_RETRY_POLICY, withRetry } from "./retry.js"

// Router
export { MessageRouter } from "./router.js"
export type { ConversationStore, RunTrigger } from "./router.js"

// Persistence
export {
  deleteChannelConfig,
  getChannelConfig,
  getDeliveryAttempts,
  getDeliveryStats,
  getOutboundMessages,
  listChannelConfigs,
  saveChannelConfig,
  SqliteConversationStore,
  SqliteQueueStore
} from "./store.js"
