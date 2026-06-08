/**
 * Server-package vitest setup.
 *
 * Existing decide-sections / prompt-token-diet tests assert that a
 * specific deployment's banking/DWH domain vocabulary (revenue,
 * client, banker, RWA, …) and tenant-specific operational identifiers
 * (`mymi`, `uspSync*`, `pipelineActivity`, `gateMetadata`) trigger the
 * DB / sync gate. Phase 5 of the de-hardcode refactor moved those
 * tokens out of code into tenant config. We register them here for
 * the test process so the existing behavioural contracts stay
 * green — exactly as a real deployment would do via the
 * `MIA_TENANT_CONFIG` env var.
 *
 * Tests that need a different (or empty) tenant config can call
 * `setTenantConfig(...)` inside their own `beforeEach`.
 */
import { setTenantConfig } from "@mia/agent"
import { beforeAll, beforeEach } from "vitest"
import { _resetDecideSectionsCache } from "../src/features/runs/core/decide-sections.ts"

beforeAll(() => {
  setTenantConfig({
    mirrorSchema: "persistedView",
    routingKeywords: {
      schemas: ["publish", "fact", "dim", "core", "gate", "archive", "persistedview"],
      domain: [
        "client",
        "clients",
        "customer",
        "customers",
        "banker",
        "bankers",
        "revenue",
        "balance",
        "balances",
        "merchant",
        "merchants",
        "risk",
        "rwa",
        "impairment",
        "trading",
        "market",
        "markets",
        "sales credit",
        "sales credits",
        "africaflex",
        "africabrains",
        "FrontArena",
        "UnoTranspose",
        "IMEX",
        "country",
        "countries",
        "branch",
        "branches",
        "cost centre",
        "cost center",
        "counterparty",
        "facility",
        "book group",
        "segment",
        "breakdown"
      ],
      sync: ["uspSync", "mymi", "pipelineActivity", "gateMetadata"]
    }
  })
})

beforeEach(() => {
  // The decide-sections regex cache memoises on tenant inputs; if a
  // test mutates tenant config the cache stays stale otherwise.
  _resetDecideSectionsCache()
})
