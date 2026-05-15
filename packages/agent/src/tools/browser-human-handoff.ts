import { HUMAN_HANDOFF_REASON_VALUES, HumanHandoffReason, UserInputStatus } from "@mia/agent"
/**
 * browser_human_handoff — escalate to a human when the browser hits a
 * step automation can't (or shouldn't) do: CAPTCHA, non-TOTP 2FA push
 * notifications, click-through warnings, etc.
 *
 * The host (server) mints a noVNC URL pointing at the *live* sandbox
 * browser session so the user can drive it with their own keyboard and
 * mouse. The tool blocks until the user marks the handoff completed (or
 * it times out / is revoked), at which point control returns to the
 * agent and the original session is still available.
 *
 * Refused (returns an error) when no {@link BrowserHandoffProvider} is
 * installed — that means CLI, tests, or anonymous tenants. Anonymous
 * users can never request a handoff because the URL would be unauthenticated.
 *
 * @module
 */

import { currentRuntime } from "../agent-runtime.js"
import type { Tool } from "../types.js"
import { getSession } from "./browse-web/session.js"

export const browserHumanHandoffTool: Tool = {
  name: "browser_human_handoff",
  description:
    "Hand the live browser session to the user via a noVNC URL when a step needs human input " +
    "(CAPTCHA, push 2FA, click-through warnings). Blocks until the user marks it complete, " +
    "is revoked, or expires. After the call returns successfully the same browse_web session " +
    "is still active and the agent can continue.",
  parameters: {
    type: "object",
    properties: {
      session_id: { type: "string", description: "Active browse_web session id." },
      reason: {
        type: "string",
        enum: [...HUMAN_HANDOFF_REASON_VALUES],
        description: "Why the agent is escalating. 'manual' = generic human-in-the-loop ask.",
      },
      message: {
        type: "string",
        description: "Short message shown to the user explaining what to do (1-2 sentences).",
      },
      ttl_seconds: {
        type: "number",
        description: "Optional TTL in seconds (default 600 = 10 minutes). Capped server-side.",
      },
    },
    required: ["session_id", "reason", "message"],
  },
  async execute(args) {
    const sessionId = String(args["session_id"] ?? "")
    const reasonRaw = String(args["reason"] ?? HumanHandoffReason.Manual)
    const reason: HumanHandoffReason =
      reasonRaw === HumanHandoffReason.Captcha || reasonRaw === HumanHandoffReason.TwoFA
        ? (reasonRaw as HumanHandoffReason)
        : HumanHandoffReason.Manual
    const message = String(args["message"] ?? "Please complete the step in the browser window.")
    const ttlSecondsRaw = args["ttl_seconds"]
    const ttlMs = typeof ttlSecondsRaw === "number" && ttlSecondsRaw > 0
      ? Math.floor(ttlSecondsRaw * 1000)
      : undefined

    const session = getSession(sessionId)
    if (typeof session === "string") return session // error message

    const provider = currentRuntime().browseWeb.handoffProvider
    if (!provider) {
      return "browser_human_handoff is not available: no handoff provider installed (anonymous session, CLI, or tests). Cannot escalate to a human."
    }

    const minted = await provider.request({
      browserSessionId: sessionId,
      reason,
      ...(ttlMs ? { ttlMs } : {}),
    })
    if (!minted) {
      return "browser_human_handoff was refused by the host (likely an anonymous session). Cannot escalate to a human."
    }

    // Block until the user resolves or it times out. The result lets the
    // model decide whether to keep going or surface the failure.
    const result = await provider.await(minted.id)
    const human = `Handoff URL: ${minted.url}\nReason: ${reason}\nMessage to user: ${message}\nResolution: ${result.status}`
    if (result.status === UserInputStatus.Completed) return `${human}\n\nUser completed the step. The browser session is still active; continue.`
    if (result.status === UserInputStatus.Expired) return `${human}\n\nHandoff expired before the user completed it. Try again, ask the user, or report the blocker.`
    return `${human}\n\nHandoff was revoked by the user. Stop the current task and ask what they want to do next.`
  },
}
