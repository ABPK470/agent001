/**
 * Global vitest setup — runs once per worker before any test file.
 *
 * Installs the canonical fixture catalog so tests that exercise scan
 * guards / branch-aggregation guards / mirror suggestions have realistic
 * catalog data available via `getCatalog()` without each test having to
 * boot a live MSSQL connection.
 *
 * Tests that need to assert behaviour with NO catalog can call
 * `clearFixtureCatalog()` in their own `beforeAll`.
 * Tests that need a DIFFERENT catalog shape can call
 * `installFixtureCatalog(myGraph)` in their own setup.
 */
import { afterAll, beforeAll } from "vitest"
import { getTenantConfig, resetTenantConfig, setTenantConfig } from "../src/tenant/config.js"
import { _resetCatalogQueriesCache } from "../src/tools/catalog/queries.js"
import { clearFixtureCatalog, installCanonicalFixtureCatalog } from "./helpers/fixture-catalog.js"

beforeAll(() => {
  installCanonicalFixtureCatalog()
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
  clearFixtureCatalog()
  resetTenantConfig()
  _resetCatalogQueriesCache()
})
