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
export { MessengerChannel } from "./messenger.js"
export { WhatsAppChannel } from "./whatsapp.js"

// Queue + retry
export { MessageQueue } from "./queue.js"
export type { QueueStore } from "./queue.js"
export { ChannelApiError, DEFAULT_RETRY_POLICY, computeDelay, withRetry } from "./retry.js"

// Router
export { MessageRouter } from "./router.js"
export type { ConversationStore, RunTrigger } from "./router.js"

// Persistence
export {
    SqliteConversationStore,
    SqliteQueueStore, deleteChannelConfig, getChannelConfig, getDeliveryAttempts,
    getDeliveryStats, getOutboundMessages, listChannelConfigs, migrateChannels,
    saveChannelConfig
} from "./store.js"

