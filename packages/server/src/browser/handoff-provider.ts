/**
 * Server-side visible-browser handoff provider.
 *
 * Bridges the agent's {@link BrowserHandoffProvider} interface to the
 * in-process handoff registry. The server binds the owner UPN explicitly
 * when it constructs the provider for a run; anonymous runs cannot claim
 * a handoff URL.
 *
 * @module
 */

import { type BrowserHandoffProvider, UserInputStatus } from "@mia/agent"

import { HandoffStatus } from "../enums/browser.js"
import { awaitHandoff, mintHandoff } from "./handoff.js"

export function createServerBrowserHandoffProvider(ownerUpn: string | null): BrowserHandoffProvider {
  return {
    async request(input) {
      if (!ownerUpn) return null
      const rec = mintHandoff({
        ownerUpn,
        browserSessionId: input.browserSessionId,
        reason: input.reason,
        ...(input.ttlMs ? { ttlMs: input.ttlMs } : {})
      })
      return { id: rec.id, url: rec.url, expiresAt: rec.expiresAt }
    },

    async await(id) {
      const rec = await awaitHandoff(id)
      if (rec.status === HandoffStatus.Completed) return { status: UserInputStatus.Completed }
      if (rec.status === HandoffStatus.Expired) return { status: UserInputStatus.Expired }
      return { status: UserInputStatus.Revoked }
    }
  }
}

export const serverBrowserHandoffProvider: BrowserHandoffProvider = createServerBrowserHandoffProvider(null)
