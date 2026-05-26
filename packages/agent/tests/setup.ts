/**
 * Global vitest setup — runs once per worker before any test file.
 *
 * Keeps tenant config deterministic for tests that render prompt variables
 * or apply schema-ranking heuristics.
 */
import { afterAll, beforeAll } from "vitest"
import { getTenantConfig, resetTenantConfig, setTenantConfig } from "../src/application/shell/tenant-config.js"
import { _resetCatalogQueriesCache } from "../src/tools/catalog/queries.js"

beforeAll(() => {
  // Tests assume the canonical deployment shape: a mirror schema named
  // `persistedview` and the legacy schemaRanking. Production deployments
  // configure these via env/json; here we just match the fixture catalog.
  setTenantConfig({
    ...getTenantConfig(),
    mirrorSchema: "persistedview",
    schemaRanking: { publish: 50, persistedview: 45, fact: 20, dim: 20, list: 5, archive: -20, etl: -20 },
  })
})

afterAll(() => {
  resetTenantConfig()
  _resetCatalogQueriesCache()
})
