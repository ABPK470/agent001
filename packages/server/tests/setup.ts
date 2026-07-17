/**
 * Server-package vitest setup.
 *
 * Registers MyMI-shaped tenant config and published sync vocabulary the
 * same way production does via MIA_TENANT_CONFIG + definitions.bundle.json.
 */
import { loadPublishedSyncEntityIdsFromBundle, setTenantConfig } from "@mia/agent"
import { beforeAll, beforeEach } from "vitest"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { _resetDecideSectionsCache } from "../src/api/runs/prompting/decide-sections.ts"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

process.env.MIA_SKIP_SETUP = "1"

beforeAll(() => {
  loadPublishedSyncEntityIdsFromBundle("sync-definitions/published/definitions.bundle.json", {
    baseDir: repoRoot
  })

  setTenantConfig({
    mirrorSchema: "persistedView",
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
      "breakdown",
      "exposure",
      "mymi",
      "uspSync"
    ]
  })
})

beforeEach(() => {
  _resetDecideSectionsCache()
})
