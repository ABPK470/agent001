/**
 * Backfills executionFlow.catalog on the checked-in bundle (run once after deploy).
 * npx vitest run scripts/backfill-published-bundle-catalog.test.ts
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { PublishedSyncDefinitionBundle } from "@mia/shared-types"
import { describe, expect, it } from "vitest"

import { loadDeployFlowCatalogForTests } from "../src/domain/test-flow-catalog.js"
import { REPO_ROOT } from "../src/test-support/repo-bundle.js"

describe("backfill published bundle catalog", () => {
  it("writes catalog snapshots into definitions.bundle.json", () => {
    const bundlePath = join(REPO_ROOT, "sync-definitions/published/definitions.bundle.json")
    const bundle = JSON.parse(readFileSync(bundlePath, "utf-8")) as PublishedSyncDefinitionBundle
    const flowCatalog = loadDeployFlowCatalogForTests(REPO_ROOT)

    let updated = 0
    for (const def of Object.values(bundle.definitions)) {
      if (!def) continue
      const snap = flowCatalog.snapForSteps(def.executionFlow.steps)
      const needsCatalog = !def.executionFlow.catalog
      const needsCustomSources =
        def.executionFlow.catalog &&
        (!def.executionFlow.catalog.customValueSources ||
          Object.keys(def.executionFlow.catalog.customValueSources).length === 0)
      if (!needsCatalog && !needsCustomSources) continue
      def.executionFlow.catalog = needsCatalog
        ? snap
        : { ...def.executionFlow.catalog, customValueSources: snap.customValueSources }
      updated += 1
    }

    writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`)
    expect(updated).toBeGreaterThanOrEqual(0)
    for (const def of Object.values(bundle.definitions)) {
      if (!def) continue
      expect(def.executionFlow.catalog?.customValueSources).toBeTruthy()
    }
  })
})
