/**
 * Registry JSON route aliases and import-registry-json endpoint.
 */

import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { formatEntityJson, parseEntitiesJson } from "../src/features/sync/domain/entity-yaml.js"
import type { EntityDefinition } from "@mia/sync"

let testDb: Database.Database
let dataDir: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

const SAMPLE: EntityDefinition = {
  id: "sample",
  tenantId: "_default",
  displayName: "Sample",
  description: "",
  rootTable: "core.Sample",
  idColumn: "sampleId",
  labelColumn: null,
  selfJoinColumn: null,
  tables: [
    {
      name: "core.Sample",
      executionOrder: 1,
      scope: { kind: "rootPk", column: "sampleId" },
      scd2Override: null,
      verified: true,
      archiveTable: null,
      note: null,
      provenance: { kind: "manual" },
      scopeColumn: "sampleId",
      source: "manual",
      groundedByPipeline: null,
      enabledByDefault: null,
      userControllable: null,
    },
  ],
  policies: { freezeWindowIds: [] },
  scd2: { strategyId: "mymi-scd2", strategyVersion: "latest", entityOverride: null },
  lineageRefs: [],
  provenance: { kind: "manual" },
  legacyEntrySproc: null,
  reverseOrder: [],
  discrepancies: [],
  version: 1,
  versionLabel: null,
  createdBy: "test",
  reason: "test",
  createdAt: new Date().toISOString(),
  retiredAt: null,
}

describe("registry JSON format routes", () => {
  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "registry-json-route-test-"))
    process.env["MIA_DATA_DIR"] = dataDir
    testDb = new Database(":memory:")
    const { _setDb, _migrate } = await import("../src/platform/persistence/db/index.js")
    _setDb(testDb)
    _migrate(testDb)
  })

  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true })
    process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
  })

  it("round-trips registry JSON through parseEntitiesJson", () => {
    const text = formatEntityJson(SAMPLE, {
      template: "metadataOnly",
      service: "default",
      environment: "default",
    })
    const parsed = parseEntitiesJson(text)
    expect(parsed[0]?.ok).toBe(true)
    expect(parsed[0]?.def?.id).toBe("sample")
    expect(parsed[0]?.run?.template).toBe("metadataOnly")
  })
})
