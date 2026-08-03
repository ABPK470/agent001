/**
 * PlatformStore composition root — selected by `MIA_PLATFORM_STORE`.
 *
 * Default sqlite; mssql and postgres are optional peers — open via
 * {@link openConfiguredPlatformStore} before product traffic for server RDBMS.
 */

import type { PlatformStore } from "../../ports/platform-store.js"
import { getPlatformStore as getSqlitePlatformStore } from "./adapters/sqlite/platform-store.js"
import { resolvePlatformStoreKind } from "./platform-store-config.js"

let cached: PlatformStore | null = null

/** Boot / openConfiguredPlatformStore — install the live handle. */
export function _setPlatformStoreCache(store: PlatformStore): void {
  cached = store
}

export function getPlatformStore(): PlatformStore {
  if (cached) return cached
  const kind = resolvePlatformStoreKind()
  if (kind === "sqlite") {
    cached = getSqlitePlatformStore()
    return cached
  }
  throw new Error(
    `${kind} PlatformStore is not open — call openConfiguredPlatformStore() at boot before getPlatformStore()`,
  )
}

/**
 * Boot helper — allow sqlite|mssql|postgres.
 * Callers must still open server RDBMS stores via {@link openConfiguredPlatformStore}.
 */
export function assertPlatformStoreReady(
  env: NodeJS.ProcessEnv = process.env,
): ReturnType<typeof resolvePlatformStoreKind> {
  return resolvePlatformStoreKind(env)
}

/** Test hook. */
export function _resetPlatformStoreCacheForTests(): void {
  cached = null
}
