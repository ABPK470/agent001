/**
 * Microsoft Teams Bot Framework channel.
 *
 * Inbound:  POST /webhooks/teams — Bot Framework Activity sent by Teams
 * Outbound: Bot Connector REST API (replies to conversations)
 * Auth:     JWT Bearer token validation on inbound (Bot Framework OpenID);
 *           OAuth 2.0 client credentials for outbound
 *
 * ── Setup ────────────────────────────────────────────────────────
 * 1. Register an Azure Bot at https://portal.azure.com
 * 2. Add Microsoft Teams as a channel in the bot's Channels blade
 * 3. Note the App ID and create an App Password (client secret)
 * 4. Set the messaging endpoint to:  https://<your-host>/webhooks/teams
 *
 * ── Channel config fields ─────────────────────────────────────────
 *   platformId  = Microsoft App ID  (Bot's application/client ID)
 *   appSecret   = Microsoft App Password / client secret
 *   accessToken = unused (leave blank — tokens are fetched via OAuth)
 *   verifyToken = unused (leave blank)
 */

import { createPublicKey, createVerify } from "node:crypto"
import { ChannelType } from "../../enums/channels.js"
import { ChannelApiError } from "./retry.js"
import type { Channel, ChannelConfig, InboundMessage } from "./types.js"

// ── Bot Framework JWKS cache ─────────────────────────────────────

type PublicKeyMap = Map<string, ReturnType<typeof createPublicKey>>

let _jwksCache: { keys: PublicKeyMap; fetchedAt: number } | null = null
const JWKS_TTL_MS = 60 * 60 * 1000 // refresh keys once per hour

async function getPublicKey(kid: string): Promise<ReturnType<typeof createPublicKey> | null> {
  const now = Date.now()
  if (!_jwksCache || now - _jwksCache.fetchedAt > JWKS_TTL_MS) {
    const oidcRes = await fetch("https://login.botframework.com/v1/.well-known/openidconfiguration")
    if (!oidcRes.ok) return null
    const oidc = (await oidcRes.json()) as { jwks_uri: string }

    const jwksRes = await fetch(oidc.jwks_uri)
    if (!jwksRes.ok) return null
    const jwks = (await jwksRes.json()) as {
      keys: Array<{ kid: string; kty: string; n: string; e: string; [k: string]: unknown }>
    }

    const keys: PublicKeyMap = new Map()
    for (const k of jwks.keys) {
      if (k.kty === "RSA" && k.kid) {
        try {
          // Strip non-JWK props before passing to createPublicKey
          const { kid: _kid, kty: _kty, n, e, use, alg } = k
          const jwk: Record<string, string> = { kty: "RSA", n, e }
          if (use) jwk.use = String(use)
          if (alg) jwk.alg = String(alg)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          keys.set(k.kid, createPublicKey({ key: jwk, format: "jwk" } as any))
        } catch {
          // skip malformed keys
        }
      }
    }
    _jwksCache = { keys, fetchedAt: now }
  }
  return _jwksCache.keys.get(kid) ?? null
}

/**
 * Validate a Bot Framework JWT Bearer token.
 *
 * Checks:  signature (RS256 against Bot Framework JWKS)
 *          audience  = bot App ID
 *          issuer    = Bot Framework or Azure AD
 *          expiry
 */
export async function validateBotFrameworkToken(token: string, appId: string): Promise<boolean> {
  try {
    const parts = token.split(".")
    if (parts.length !== 3) return false

    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as {
      kid?: string
      alg?: string
    }
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      aud?: string
      iss?: string
      exp?: number
      tid?: string
    }

    // Audience must be this bot's App ID
    if (payload.aud !== appId) return false

    // Issuer: Bot Framework service or Azure AD (for channel service)
    const validIssuers = [
      "https://api.botframework.com",
      // Azure AD v1 (Government: d6d49420-f39b-4df7-a1dc-d59a935871db)
      `https://sts.windows.net/${payload.tid ?? ""}/`,
      // Azure AD v2
      `https://login.microsoftonline.com/${payload.tid ?? ""}/v2.0`
    ]
    if (!validIssuers.includes(payload.iss ?? "")) return false

    // Not expired (exp is Unix seconds)
    if (payload.exp !== undefined && Date.now() / 1000 > payload.exp) return false

    // Verify the RSA-SHA256 signature
    const publicKey = header.kid ? await getPublicKey(header.kid) : null
    if (!publicKey) return false

    const verifier = createVerify("RSA-SHA256")
    verifier.update(`${parts[0]}.${parts[1]}`)
    return verifier.verify(publicKey, parts[2]!, "base64url")
  } catch {
    return false
  }
}

// ── Outbound OAuth token cache ────────────────────────────────────

interface TokenCache {
  token: string
  expiresAt: number
}

const _tokenCache = new Map<string, TokenCache>()

async function fetchBotToken(appId: string, appPassword: string): Promise<string> {
  const cached = _tokenCache.get(appId)
  // Refresh 60 s before expiry
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token

  const res = await fetch("https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: appId,
      client_secret: appPassword,
      scope: "https://api.botframework.com/.default"
    })
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new ChannelApiError(`Teams OAuth error ${res.status}: ${JSON.stringify(body)}`, res.status, body)
  }

  const data = (await res.json()) as { access_token: string; expires_in: number }
  const entry: TokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000
  }
  _tokenCache.set(appId, entry)
  return entry.token
}

// ── Conversation reference encoding ──────────────────────────────

/**
 * All the context needed to send a reply back through the Bot Connector.
 * Encoded as JSON and stored in OutboundMessage.recipientId.
 */
export interface TeamsConversationRef {
  serviceUrl: string
  conversationId: string
  userId: string
}

// ── Teams channel ─────────────────────────────────────────────────

export class TeamsChannel implements Channel {
  readonly type = ChannelType.Teams
  private readonly config: ChannelConfig

  constructor(config: ChannelConfig) {
    this.config = config
  }

  /**
   * Send a text message via the Bot Connector REST API.
   *
   * `recipientId` must be a JSON-encoded TeamsConversationRef (set automatically
   * by parseWebhook when the inbound activity is received).
   */
  async sendMessage(recipientId: string, text: string): Promise<string> {
    let ref: TeamsConversationRef
    try {
      ref = JSON.parse(recipientId) as TeamsConversationRef
    } catch {
      throw new Error("Teams recipientId must be a JSON-encoded TeamsConversationRef")
    }

    const token = await fetchBotToken(this.config.platformId, this.config.appSecret)
    const base = ref.serviceUrl.replace(/\/$/, "")
    const url = `${base}/v3/conversations/${encodeURIComponent(ref.conversationId)}/activities`

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        type: "message",
        from: { id: this.config.platformId },
        recipient: { id: ref.userId },
        text
      })
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new ChannelApiError(`Teams API error ${res.status}: ${JSON.stringify(body)}`, res.status, body)
    }

    const result = (await res.json()) as { id?: string }
    return result.id ?? "unknown"
  }

  /**
   * Validate the inbound Bot Framework JWT Bearer token.
   *
   * The `signature` parameter is expected to be the raw value of the
   * Authorization header (including the "Bearer " prefix).
   * The `payload` buffer is not used — Teams auth is purely header-based.
   */
  validateSignature(_payload: Buffer, signature: string): Promise<boolean> {
    const token = signature.startsWith("Bearer ") ? signature.slice(7) : signature
    return validateBotFrameworkToken(token, this.config.platformId)
  }

  /** Parse a Teams Bot Framework Activity into inbound messages. */
  parseWebhook(body: unknown): InboundMessage[] {
    const activity = body as TeamsActivity
    if (activity?.type !== "message" || !activity.text?.trim()) return []

    const userId = activity.from?.id ?? "unknown"

    // Encode the conversation reference into senderId so the router can
    // pass it to sendMessage() when replying.
    const ref: TeamsConversationRef = {
      serviceUrl: activity.serviceUrl ?? "",
      conversationId: activity.conversation?.id ?? "",
      userId
    }

    return [
      {
        platformMessageId: activity.id ?? `teams-${Date.now()}`,
        channelType: ChannelType.Teams,
        senderId: JSON.stringify(ref),
        senderName: activity.from?.name,
        text: activity.text.trim(),
        raw: activity,
        receivedAt: new Date()
      }
    ]
  }
}

// ── Bot Framework Activity types ──────────────────────────────────

interface TeamsActivity {
  type?: string
  id?: string
  timestamp?: string
  serviceUrl?: string
  locale?: string
  from?: { id: string; name?: string; role?: string }
  conversation?: {
    id: string
    isGroup?: boolean
    conversationType?: string
    name?: string
  }
  recipient?: { id: string; name?: string }
  text?: string
  channelId?: string
  channelData?: unknown
}
