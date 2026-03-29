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
  RetryPolicy,
} from "./types.js"

// Channels
export { WhatsAppChannel } from "./whatsapp.js"
export { MessengerChannel } from "./messenger.js"

// Queue + retry
export { MessageQueue } from "./queue.js"
export type { QueueStore } from "./queue.js"
export { ChannelApiError, DEFAULT_RETRY_POLICY, withRetry, computeDelay } from "./retry.js"

// Router
export { MessageRouter } from "./router.js"
export type { ConversationStore, RunTrigger } from "./router.js"

// Persistence
export {
  SqliteConversationStore,
  SqliteQueueStore,
  migrateChannels,
  saveChannelConfig,
  getChannelConfig,
  listChannelConfigs,
  deleteChannelConfig,
  getOutboundMessages,
  getDeliveryAttempts,
  getDeliveryStats,
} from "./store.js"
