/**
 * WhatsApp Business Cloud API channel.
 *
 * Implements the Channel interface for WhatsApp Business Platform.
 *
 * API docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 *
 * Sending: POST to graph.facebook.com/v21.0/{phone_number_id}/messages
 * Webhooks: Verify with hub.verify_token, validate with HMAC-SHA256
 */

import { validateHmacSignature } from "./crypto.js"
import { ChannelApiError } from "./retry.js"
import type { Channel, ChannelConfig, InboundMessage } from "./types.js"

const GRAPH_API_VERSION = "v21.0"
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`

export class WhatsAppChannel implements Channel {
  readonly type = "whatsapp" as const
  private readonly config: ChannelConfig

  constructor(config: ChannelConfig) {
    this.config = config
  }

  /** Send a text message via WhatsApp Cloud API. */
  async sendMessage(recipientId: string, text: string): Promise<string> {
    const url = `${GRAPH_API_BASE}/${this.config.platformId}/messages`

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.config.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipientId,
        type: "text",
        text: { body: text },
      }),
    })

    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      throw new ChannelApiError(
        `WhatsApp API error ${response.status}: ${JSON.stringify(body)}`,
        response.status,
        body,
      )
    }

    const result = await response.json() as { messages?: { id: string }[] }
    return result.messages?.[0]?.id ?? "unknown"
  }

  validateSignature(payload: Buffer, signature: string): boolean {
    return validateHmacSignature(payload, signature, this.config.appSecret)
  }

  /** Parse WhatsApp webhook payload into inbound messages. */
  parseWebhook(body: unknown): InboundMessage[] {
    const messages: InboundMessage[] = []
    const payload = body as WhatsAppWebhookPayload

    if (payload?.object !== "whatsapp_business_account") return messages

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "messages") continue
        const value = change.value
        if (!value?.messages) continue

        const contacts = new Map(
          (value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]),
        )

        for (const msg of value.messages) {
          if (msg.type !== "text" || !msg.text?.body) continue

          messages.push({
            platformMessageId: msg.id,
            channelType: "whatsapp",
            senderId: msg.from,
            senderName: contacts.get(msg.from),
            text: msg.text.body,
            raw: msg,
            receivedAt: new Date(),
          })
        }
      }
    }

    return messages
  }
}

// ── WhatsApp webhook types ───────────────────────────────────────

interface WhatsAppWebhookPayload {
  object?: string
  entry?: {
    id: string
    changes: {
      field: string
      value: {
        messaging_product: string
        metadata: { display_phone_number: string; phone_number_id: string }
        contacts?: { wa_id: string; profile?: { name?: string } }[]
        messages?: {
          id: string
          from: string
          timestamp: string
          type: string
          text?: { body: string }
        }[]
        statuses?: {
          id: string
          status: string
          timestamp: string
          recipient_id: string
          errors?: { code: number; title: string }[]
        }[]
      }
    }[]
  }[]
}
