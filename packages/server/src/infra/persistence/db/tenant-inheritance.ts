import { DEFAULT_TENANT_ID } from "@mia/sync"

/** Tenants whose persisted mutations refresh the in-process global registry. */
const GLOBAL_REGISTRY_MUTATION_TENANTS = new Set<string>([DEFAULT_TENANT_ID])

/** Explicit per-tenant strategy inheritance chain (empty = bundled tenant only). */
const STRATEGY_INHERITANCE_CHAIN: Readonly<Record<string, readonly string[]>> = {
  [DEFAULT_TENANT_ID]: []
}

/** Tenants that consult bundled defaults when local strategy rows are absent. */
const STRATEGY_BUNDLED_FALLBACK_TENANTS = new Set<string>([DEFAULT_TENANT_ID])

export function refreshesGlobalRegistryOnMutation(tenantId: string): boolean {
  return GLOBAL_REGISTRY_MUTATION_TENANTS.has(tenantId)
}

/** Ordered tenant ids to consult when resolving a strategy version. */
export function strategyResolutionTenants(tenantId: string): readonly string[] {
  const configured = STRATEGY_INHERITANCE_CHAIN[tenantId]
  if (configured !== undefined) {
    return configured.length === 0 ? [tenantId] : [tenantId, ...configured]
  }
  return STRATEGY_BUNDLED_FALLBACK_TENANTS.has(tenantId) ? [tenantId] : [tenantId, DEFAULT_TENANT_ID]
}

/** Ordered tenant ids for strategy version history (newest tenant first). */
export function strategyHistoryTenants(tenantId: string): readonly string[] {
  return strategyResolutionTenants(tenantId)
}

/** Whether bundled-tenant strategies merge into a tenant listing. */
export function mergesBundledStrategies(tenantId: string): boolean {
  return !STRATEGY_BUNDLED_FALLBACK_TENANTS.has(tenantId)
}
