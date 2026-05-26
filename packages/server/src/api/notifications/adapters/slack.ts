/**
 * F1.10 — Slack incoming-webhook delivery.
 *
 * `target` is the webhook URL. Uses the standard `text` + `blocks`
 * payload so the message renders nicely in both desktop and mobile.
 */

import type { RenderedBody } from "../templates.js"

export interface SlackDeliveryInput {
  target: string
  body:   RenderedBody
}

export async function deliverSlack(i: SlackDeliveryInput): Promise<void> {
  if (!/^https?:\/\//u.test(i.target)) throw new Error("Slack target must be a webhook URL")
  const payload = {
    text: i.body.subject,
    blocks: [
      { type: "header", text: { type: "plain_text", text: i.body.subject.slice(0, 150) } },
      { type: "section", text: { type: "mrkdwn", text: "```" + i.body.text.slice(0, 2900) + "```" } },
    ],
  }
  const r = await fetch(i.target, {
    method:  "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify(payload),
  })
  if (!r.ok) {
    const txt = await safeText(r)
    throw new Error(`Slack webhook ${r.status}: ${txt}`)
  }
}

async function safeText(r: Response): Promise<string> {
  try { return (await r.text()).slice(0, 500) } catch { return "<no body>" }
}
