/**
 * F1.10 — Microsoft Teams incoming-webhook delivery.
 *
 * `target` is the webhook URL. We send a minimal "MessageCard" payload
 * since that surface is the most widely-supported (vs. Adaptive Cards
 * which require an O365 connector). Two retries above the router's
 * retry envelope = network-level resilience.
 */

import type { RenderedBody } from "../service/templates.js"

export interface TeamsDeliveryInput {
  target: string
  body: RenderedBody
}

export async function deliverTeams(i: TeamsDeliveryInput): Promise<void> {
  if (!/^https?:\/\//u.test(i.target)) throw new Error("Teams target must be a webhook URL")
  const payload = {
    "@type": "MessageCard",
    "@context": "https://schema.org/extensions",
    summary: i.body.subject,
    themeColor: "0078D4",
    title: i.body.subject,
    text: i.body.text.replace(/\n/g, "<br/>")
  }
  const r = await fetch(i.target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  })
  if (!r.ok) {
    const txt = await safeText(r)
    throw new Error(`Teams webhook ${r.status}: ${txt}`)
  }
}

async function safeText(r: Response): Promise<string> {
  try {
    return (await r.text()).slice(0, 500)
  } catch {
    return "<no body>"
  }
}
