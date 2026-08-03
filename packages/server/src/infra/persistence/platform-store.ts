/**
 * PlatformStore composition root — selected by `MIA_PLATFORM_STORE`.
 *
 * SQLite is the only implemented adapter today. mssql|postgres fail loudly
 * until a second dialect adapter lands (plan milestone 4).
 */

import type { PlatformStore } from "../../ports/platform-store.js"
import { createMssqlPlatformStore } from "./adapters/mssql/platform-store.js"
import { createPostgresPlatformStore } from "./adapters/postgres/platform-store.js"
import { getPlatformStore as getSqlitePlatformStore } from "./adapters/sqlite/platform-store.js"
import { resolvePlatformStoreKind } from "./platform-store-config.js"

let cached: PlatformStore | null = null

export function getPlatformStore(): PlatformStore {
  if (cached) return cached
  const kind = resolvePlatformStoreKind()
  if (kind === "sqlite") {
    cached = getSqlitePlatformStore()
    return cached
  }
  // Scaffolds throw with a milestone-4 message (same gate as assertPlatformStoreReady).
  if (kind === "mssql") return createMssqlPlatformStore()
  return createPostgresPlatformStore()
}

/** Boot helper — fail fast when an unimplemented kind is configured. */
export function assertPlatformStoreReady(
  env: NodeJS.ProcessEnv = process.env,
): ReturnType<typeof resolvePlatformStoreKind> {
  const kind = resolvePlatformStoreKind(env)
  if (kind !== "sqlite") {
    throw new Error(
      `MIA_PLATFORM_STORE=${kind} is not ready — platform persistence still requires sqlite ` +
        `(hosted default will be mssql once milestone 4 completes; repos/execute still SQLite-bound). ` +
        `Sync warehouse mssql|postgres is separate (connectors / WarehouseDialect).`,
    )
  }
  return kind
}

/** Test hook. */
export function _resetPlatformStoreCacheForTests(): void {
  cached = null
}
