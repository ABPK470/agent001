import { ChannelType, DeliveryStatus } from "../../../shared/enums/channels.js"
/**
 * Channel types — the vocabulary for multi-platform message routing.
 *
 * A Channel is any messaging platform (WhatsApp, Messenger, etc.)
 * that can send and receive messages through webhooks.
 */

// ── Delivery tracking ────────────────────────────────────────────

export { DeliveryStatus }

// ── Messages ─────────────────────────────────────────────────────

/** A message received from a user on a chat platform. */
export interface InboundMessage {
  /** Unique ID from the platform (e.g. WhatsApp message ID). */
  platformMessageId: string
  /** Channel this came from ("teams"). */
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

export { ChannelType }

/** Configuration for a registered channel. */
export interface ChannelConfig {
  type: ChannelType
  /** Microsoft App ID (Bot registration in Azure portal). */
  accessToken: string
  /** Unused — kept for schema compatibility. */
  verifyToken: string
  /** Microsoft App Password / Client Secret. */
  appSecret: string
  /** Microsoft App ID (same as accessToken — platformId is the canonical name). */
  platformId: string
}

/**
 * A messaging channel implementation.
 *
 * Each platform implements this interface.
 * The router doesn't know platform specifics — it just calls
 * sendMessage() and lets the channel handle API details.
 */
export interface Channel {
  readonly type: ChannelType

  /** Send a text message to a recipient. Returns the platform message ID. */
  sendMessage(recipientId: string, text: string): Promise<string>

  /**
   * Validate an inbound webhook request.
   * The `signature` parameter carries whatever auth token/header the platform provides.
   * May be async (e.g. Teams JWT validation requires a network key fetch).
   */
  validateSignature(payload: Buffer, signature: string): Promise<boolean> | boolean

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
