/**
 * Server-side persistent browser-context provider.
 *
 * Bridges the agent's {@link BrowserContextProvider} interface to the
 * SQLite-backed context-store. The server binds the owner UPN explicitly
 * when it constructs the provider for a run; anonymous runs get null
 * (ephemeral).
 *
 * @module
 */

import type { BrowserContextHandle, BrowserContextProvider } from "@mia/agent"

import { getOrCreateContext, loadStorageState, saveStorageState } from "./context-store.js"
import { createGuardForUpn } from "./guard.js"
import { getProxyConfig } from "./proxy.js"

export function createServerBrowserContextProvider(ownerUpn: string | null): BrowserContextProvider {
  return {
    async acquire(): Promise<BrowserContextHandle | null> {
      if (!ownerUpn) return null

      const record = getOrCreateContext(ownerUpn)
      const storageState = await loadStorageState(record)
      const proxyRow = getProxyConfig(ownerUpn)
      const proxy = proxyRow ? { server: proxyRow.server, bypass: proxyRow.bypass } : null
      const guard = createGuardForUpn(ownerUpn)

      return {
        fingerprintSeed: record.fingerprintSeed,
        storageState,
        proxy,
        guard,
        async save(state: unknown): Promise<void> {
          await saveStorageState(record, state)
        },
      }
    }
  }
}

export const serverBrowserContextProvider: BrowserContextProvider = createServerBrowserContextProvider(null)
