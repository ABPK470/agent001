/**
 * PlatformStore composition root — selected by `MIA_PLATFORM_STORE`.
 *
 * sqlite (local default) and mssql (hosted) are product-ready after async
 * cutover. postgres remains refused until a peer adapter lands.
 */

import type { PlatformStore } from "../../ports/platform-store.js"
import { createPostgresPlatformStore } from "./adapters/postgres/platform-store.js"
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
  if (kind === "mssql") {
    throw new Error(
      "MSSQL PlatformStore is not open — call openConfiguredPlatformStore() at boot before getPlatformStore()",
    )
  }
  return createPostgresPlatformStore()
}

/**
 * Boot helper — allow sqlite|mssql; refuse postgres until that adapter lands.
 * Callers must still open the store via {@link openConfiguredPlatformStore}.
 */
export function assertPlatformStoreReady(
  env: NodeJS.ProcessEnv = process.env,
): ReturnType<typeof resolvePlatformStoreKind> {
  const kind = resolvePlatformStoreKind(env)
  if (kind === "postgres") {
    throw new Error(
      `MIA_PLATFORM_STORE=postgres is not ready — platform persistence supports sqlite|mssql. ` +
        `Sync warehouse postgres is separate (WarehouseDialect).`,
    )
  }
  return kind
}

/** Test hook. */
export function _resetPlatformStoreCacheForTests(): void {
  cached = null
}
