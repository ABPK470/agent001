/**
 * Server-side visible-browser handoff provider.
 *
 * Bridges the agent's {@link BrowserHandoffProvider} interface to the
 * in-process handoff registry. Resolves the active tenant via the
 * request AsyncLocalStorage and refuses anonymous requests so an
 * unauthenticated browser session can never claim a handoff URL.
 *
 * @module
 */

import { type BrowserHandoffProvider, UserInputStatus } from "@mia/agent"

import { getCurrentSession } from "../auth/context.js"
import { HandoffStatus } from "../enums/browser.js"
import { awaitHandoff, mintHandoff } from "./handoff.js"

export const serverBrowserHandoffProvider: BrowserHandoffProvider = {
  async request(input) {
    const session = getCurrentSession()
    if (!session?.upn) return null
    const rec = mintHandoff({
      ownerUpn: session.upn,
      browserSessionId: input.browserSessionId,
      reason: input.reason,
      ...(input.ttlMs ? { ttlMs: input.ttlMs } : {}),
    })
    return { id: rec.id, url: rec.url, expiresAt: rec.expiresAt }
  },

  async await(id) {
    const rec = await awaitHandoff(id)
    if (rec.status === HandoffStatus.Completed) return { status: UserInputStatus.Completed }
    if (rec.status === HandoffStatus.Expired) return { status: UserInputStatus.Expired }
    return { status: UserInputStatus.Revoked }
  },
}
