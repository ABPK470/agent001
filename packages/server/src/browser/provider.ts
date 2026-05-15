/**
 * Server-side persistent browser-context provider.
 *
 * Bridges the agent's {@link BrowserContextProvider} interface to the
 * SQLite-backed context-store. Resolves the active tenant via the request
 * AsyncLocalStorage and only persists for authenticated users — anonymous
 * sessions get null (ephemeral).
 *
 * @module
 */

import type { BrowserContextHandle, BrowserContextProvider } from "@mia/agent"

import { getCurrentSession } from "../auth/context.js"
import { getOrCreateContext, loadStorageState, saveStorageState } from "./context-store.js"
import { createGuardForUpn } from "./guard.js"
import { getProxyConfig } from "./proxy.js"

export const serverBrowserContextProvider: BrowserContextProvider = {
  async acquire(): Promise<BrowserContextHandle | null> {
    const session = getCurrentSession()
    // Anonymous → ephemeral. The agent's launchSession will fall back to
    // its in-memory pool with a random fingerprint and no storage state.
    if (!session?.upn) return null

    const record = getOrCreateContext(session.upn)
    const storageState = await loadStorageState(record)
    const proxyRow = getProxyConfig(session.upn)
    const proxy = proxyRow ? { server: proxyRow.server, bypass: proxyRow.bypass } : null
    const guard = createGuardForUpn(session.upn)

    return {
      fingerprintSeed: record.fingerprintSeed,
      storageState,
      proxy,
      guard,
      async save(state: unknown): Promise<void> {
        await saveStorageState(record, state)
      },
    }
  },
}
