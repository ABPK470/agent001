/**
 * Public door for agent runtime (stateful drivers).
 *
 * What: Agent, host wiring, loop helpers, delegation drivers, tenant config.
 * Why: owns mutable state and drives the run.
 * Next: platform calls configureAgent / Agent.run; runtime calls core.
 */

export * from "./agent.js"
export * from "./delegate.js"
export * from "./runtime.js"
export {
  DEFAULT_CATALOG_BOOTSTRAP,
  DEFAULT_TENANT_CONFIG,
  formatTenantConfigBootSummary,
  getTenantConfig,
  isDefaultTenantConfig,
  loadTenantConfigFromEnv,
  loadTenantConfigFromFile,
  resetTenantConfig,
  resolveTenantConfigPath,
  setTenantConfig
} from "../domain/tenant/tenant-config.js"
export type { CatalogBootstrapMetadata, TenantConfig } from "../domain/tenant/tenant-config.js"
