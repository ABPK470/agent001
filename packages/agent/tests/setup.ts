/**
 * Global vitest setup — runs once per worker before any test file.
 *
 * Keeps tenant config deterministic for tests that render prompt variables
 * or apply schema-ranking heuristics.
 */
import { afterAll, beforeAll } from "vitest"
import {
  getTenantConfig,
  resetTenantConfig,
  setTenantConfig
} from "../src/application/shell/tenant-config.js"
import { _resetCatalogQueriesCache } from "../src/tools/catalog/queries.js"

beforeAll(() => {
  // Tests assume the canonical deployment shape: a mirror schema named
  // `persistedview` and the legacy schemaRanking. Production deployments
  // configure these via env/json; here we just match the fixture catalog.
  setTenantConfig({
    ...getTenantConfig(),
    mirrorSchema: "persistedview",
    catalogBootstrap: {
      largeObjects: [
        "publish.revenue",
        "publish.balances",
        "fact.unotranspose",
        "persistedview.publish.revenue",
        "persistedview.publish.balances"
      ],
      canonicalQualifiedNames: {
        "publish.revenue": "publish.Revenue",
        "publish.balances": "publish.Balances",
        "fact.unotranspose": "fact.UnoTranspose",
        "persistedview.publish.revenue": "persistedView.publish.Revenue",
        "persistedview.publish.balances": "persistedView.publish.Balances",
        client: "dim.Client",
        clients: "dim.Client",
        month: "dim.Month",
        months: "dim.Month",
        absa: "etl.ABSA_CUSTOMER"
      },
      unionBranchCounts: {
        "publish.revenue": 59,
        "publish.balances": 24,
        "persistedview.publish.revenue": 59,
        "persistedview.publish.balances": 24
      },
      highCardinalityKeys: {
        "publish.revenue": ["pkClient", "pkBranch", "pkAccount"],
        "publish.balances": ["pkClient", "pkBranch", "pkAccount"],
        "persistedview.publish.revenue": ["pkClient", "pkBranch", "pkAccount"],
        "persistedview.publish.balances": ["pkClient", "pkBranch", "pkAccount"]
      }
    },
    schemaRanking: [
      { schema: "publish", weight: 50 },
      { schema: "persistedview", weight: 45 },
      { schema: "fact", weight: 20 },
      { schema: "dim", weight: 20 },
      { schema: "list", weight: 5 },
      { schema: "archive", weight: -20 },
      { schema: "etl", weight: -20 }
    ],
    domainKeywords: [
      "client",
      "clients",
      "customer",
      "customers",
      "banker",
      "bankers",
      "revenue",
      "balance",
      "balances",
      "transaction",
      "transactions",
      "merchant",
      "merchants",
      "risk",
      "rwa",
      "impairment",
      "trading",
      "market",
      "markets",
      "absa",
      "month",
      "months"
    ]
  })
})

afterAll(() => {
  resetTenantConfig()
  _resetCatalogQueriesCache()
})
