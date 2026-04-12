/**
 * Facebook Messenger Platform channel.
 *
 * Implements the Channel interface for Facebook Messenger.
 *
 * API docs: https://developers.facebook.com/docs/messenger-platform
 *
 * Sending: POST to graph.facebook.com/v21.0/me/messages
 * Webhooks: Verify with hub.verify_token, validate with HMAC-SHA1
 */

import { validateHmacSignature } from "./crypto.js"
import { ChannelApiError } from "./retry.js"
import type { Channel, ChannelConfig, InboundMessage } from "./types.js"

const GRAPH_API_VERSION = "v21.0"
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`

export class MessengerChannel implements Channel {
  readonly type = "messenger" as const
  private readonly config: ChannelConfig

  constructor(config: ChannelConfig) {
    this.config = config
  }

  /** Send a text message via Messenger Send API. */
  async sendMessage(recipientId: string, text: string): Promise<string> {
    const url = `${GRAPH_API_BASE}/me/messages`

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        messaging_type: "RESPONSE",
        message: { text },
        access_token: this.config.accessToken,
      }),
    })

    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      throw new ChannelApiError(
        `Messenger API error ${response.status}: ${JSON.stringify(body)}`,
        response.status,
        body,
      )
    }

    const result = await response.json() as { message_id?: string }
    return result.message_id ?? "unknown"
  }

  validateSignature(payload: Buffer, signature: string): boolean {
    return validateHmacSignature(payload, signature, this.config.appSecret)
  }

  /** Parse Messenger webhook payload into inbound messages. */
  parseWebhook(body: unknown): InboundMessage[] {
    const messages: InboundMessage[] = []
    const payload = body as MessengerWebhookPayload

    if (payload?.object !== "page") return messages

    for (const entry of payload.entry ?? []) {
      for (const event of entry.messaging ?? []) {
        // Only handle text messages (skip postbacks, reactions, etc.)
        if (!event.message?.text) continue

        messages.push({
          platformMessageId: event.message.mid,
          channelType: "messenger",
          senderId: event.sender.id,
          text: event.message.text,
          raw: event,
          receivedAt: new Date(),
        })
      }
    }

    return messages
  }
}

// ── Messenger webhook types ──────────────────────────────────────

interface MessengerWebhookPayload {
  object?: string
  entry?: {
    id: string
    time: number
    messaging?: {
      sender: { id: string }
      recipient: { id: string }
      timestamp: number
      message?: {
        mid: string
        text?: string
      }
      delivery?: {
        mids: string[]
        watermark: number
      }
      read?: {
        watermark: number
      }
    }[]
  }[]
}
