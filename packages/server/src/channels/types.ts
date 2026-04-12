/**
 * Channel types — the vocabulary for multi-platform message routing.
 *
 * A Channel is any messaging platform (WhatsApp, Messenger, etc.)
 * that can send and receive messages through webhooks.
 */

// ── Delivery tracking ────────────────────────────────────────────

export type DeliveryStatus =
  | "queued"    // In the queue, not yet attempted
  | "sending"   // Currently being sent
  | "delivered" // Successfully delivered to the platform
  | "failed"    // All retries exhausted — dead letter
  | "retrying"  // Failed but will retry

// ── Messages ─────────────────────────────────────────────────────

/** A message received from a user on a chat platform. */
export interface InboundMessage {
  /** Unique ID from the platform (e.g. WhatsApp message ID). */
  platformMessageId: string
  /** Channel this came from ("whatsapp" | "messenger"). */
  channelType: ChannelType
  /** The user's ID on that platform (e.g. phone number, PSID). */
  senderId: string
  /** Display name of the sender, if available. */
  senderName?: string
  /** The message text. */
  text: string
  /** Raw webhook payload for debugging. */
  raw: unknown
  /** When the message was received by our server. */
  receivedAt: Date
}

/** A message to be sent to a user on a chat platform. */
export interface OutboundMessage {
  /** Our internal message ID. */
  id: string
  /** Which conversation this belongs to. */
  conversationId: string
  /** The channel to send through. */
  channelType: ChannelType
  /** Recipient ID on the platform. */
  recipientId: string
  /** Text to send. */
  text: string
  /** Current delivery status. */
  status: DeliveryStatus
  /** How many times we've tried to send this. */
  attempts: number
  /** When to retry next (null if not retrying). */
  nextRetryAt: Date | null
  /** Error from the last failed attempt. */
  lastError: string | null
  /** When this message was created. */
  createdAt: Date
  /** When delivery was confirmed. */
  deliveredAt: Date | null
}

// ── Channel interface ────────────────────────────────────────────

export type ChannelType = "whatsapp" | "messenger"

/** Configuration for a registered channel. */
export interface ChannelConfig {
  type: ChannelType
  /** Platform API token for sending messages. */
  accessToken: string
  /** Webhook verification token. */
  verifyToken: string
  /** Secret for validating webhook signatures. */
  appSecret: string
  /** Platform-specific: WhatsApp phone number ID, Messenger page ID, etc. */
  platformId: string
}

/**
 * A messaging channel implementation.
 *
 * Each platform (WhatsApp, Messenger) implements this interface.
 * The router doesn't know platform specifics — it just calls
 * sendMessage() and lets the channel handle API details.
 */
export interface Channel {
  readonly type: ChannelType

  /** Send a text message to a recipient. Returns the platform message ID. */
  sendMessage(recipientId: string, text: string): Promise<string>

  /** Validate a webhook signature. Returns true if authentic. */
  validateSignature(payload: Buffer, signature: string): boolean

  /** Parse a raw webhook body into inbound messages. Returns [] if not a message event. */
  parseWebhook(body: unknown): InboundMessage[]
}

// ── Conversation ─────────────────────────────────────────────────

/** Maps a platform user to an agent run. */
export interface Conversation {
  id: string
  channelType: ChannelType
  /** User's ID on the platform. */
  senderId: string
  /** User's display name. */
  senderName: string | null
  /** The currently active agent run for this conversation. */
  activeRunId: string | null
  createdAt: Date
  updatedAt: Date
}

// ── Retry policy ─────────────────────────────────────────────────

export interface RetryPolicy {
  /** Maximum number of retry attempts. Default: 5 */
  maxRetries: number
  /** Base delay in ms before first retry. Default: 1000 */
  baseDelayMs: number
  /** Maximum delay in ms between retries. Default: 60000 */
  maxDelayMs: number
  /** Multiplier for exponential backoff. Default: 2 */
  backoffMultiplier: number
  /** Jitter factor (0-1). 0.5 = up to 50% random jitter. Default: 0.5 */
  jitterFactor: number
}
