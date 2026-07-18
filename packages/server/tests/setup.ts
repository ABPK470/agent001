/**
 * Server-package vitest setup.
 *
 * Registers MyMI-shaped tenant config and published sync vocabulary the
 * same way production does after Publish (entity ids from SQLite rows).
 * Tests that exercise a live DB may re-seed / reload vocabulary themselves.
 */
import { loadPublishedSyncEntityIdsFromList, setTenantConfig } from "@mia/agent"
import { beforeAll, beforeEach } from "vitest"
import { _resetDecideSectionsCache } from "../src/api/runs/prompting/decide-sections.ts"

process.env.MIA_SKIP_SETUP = "1"

/** Canonical MyMI entity types — matches a full Publish into sync_definitions. */
const PUBLISHED_SYNC_VOCABULARY = [
  "content",
  "contract",
  "dataset",
  "gateMetadata",
  "pipelineActivity",
  "rule",
] as const

beforeAll(() => {
  loadPublishedSyncEntityIdsFromList(PUBLISHED_SYNC_VOCABULARY)

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
