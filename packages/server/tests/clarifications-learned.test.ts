/**
 * persistLearnedTermFromResolution — extracts a `schema.table` qname from a
 * clarification answer, verifies it against the boot catalog, and upserts a
 * durable learned mapping. Only schema-match / canonical-ambiguity kinds are
 * learned; free-text answers without a resolvable qname are ignored.
 */

import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CatalogGraph, type CatalogTable } from "@mia/agent"
import type { BootHostDeps } from "../src/ports/orchestration.js"
import { persistLearnedTermFromResolution } from "../src/runtime/execution/clarifications-learned.js"

let testDb: Database.Database
let dataDir: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-cl-"))
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  testDb.pragma("journal_mode = WAL")
  testDb.pragma("foreign_keys = OFF")
})

afterEach(() => {
  testDb.close()
  rmSync(dataDir, { recursive: true, force: true })
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["MIA_DATA_DIR"]
  else process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
})

async function setupMemory() {
  const { _setDb, _migrate } = await import("../src/infra/persistence/db/index.js")
  _setDb(testDb)
  _migrate(testDb)
  testDb.pragma("foreign_keys = OFF")
  return await import("../src/infra/persistence/memory/index.js")
}

function fixtureCatalog(): CatalogGraph {
  const dimClient: CatalogTable = {
    schema: "dim",
    name: "Client",
    qualifiedName: "dim.Client",
    type: "TABLE",
    rowCount: null,
    columns: [{ name: "pkClient", dataType: "int", nullable: false, isPK: true, maxLength: null }],
    fkOutgoing: [],
    fkIncoming: [],
    viewDefinition: undefined
  }
  return CatalogGraph.fromSnapshot({
    version: 7,
    builtAt: new Date().toISOString(),
    source: "test",
    tables: [dimClient],
    implicitEdges: [],
    viewSourceRows: [],
    sysCatalog: []
  } as Parameters<typeof CatalogGraph.fromSnapshot>[0])
}

function bootDeps(): BootHostDeps {
  const databases = new Map<string, unknown>([["default", { config: null, pool: null, knowledge: null }]])
  const instances = new Map<string, CatalogGraph>([["default", fixtureCatalog()]])
  return {
    mssql: { databases: databases as never, defaultConnection: { value: null } },
    catalog: { instances, defaultCachePath: { value: undefined } }
  }
}

const baseResolved = {
  findingId: "schema-match:clients",
  kind: "schema-match" as const,
  subject: "clients",
  question: "When you say clients, which did you mean?",
  resolvedAtRound: 1
}

describe("persistLearnedTermFromResolution", () => {
  it("persists a schema-match answer that names a catalog qname", async () => {
    const mem = await setupMemory()
    persistLearnedTermFromResolution(
      { ...baseResolved, answer: "dim.Client" },
      "top 5 clients by revenue",
      "alice@corp",
      bootDeps()
    )
    const rows = mem.listResolvedTerms({ connection: "default" })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ term: "clients", qname: "dim.Client", createdByUpn: "alice@corp" })
  })

  it("persists a canonical-ambiguity answer too", async () => {
    const mem = await setupMemory()
    persistLearnedTermFromResolution(
      { ...baseResolved, kind: "canonical-ambiguity", answer: "dim.Client" },
      "top clients by revenue",
      null,
      bootDeps()
    )
    expect(mem.listResolvedTerms({ connection: "default" })).toHaveLength(1)
  })

  it("ignores a free-text answer with no resolvable qname", async () => {
    const mem = await setupMemory()
    persistLearnedTermFromResolution(
      { ...baseResolved, answer: "I mean the main client dimension" },
      "top clients by revenue",
      "alice@corp",
      bootDeps()
    )
    expect(mem.listResolvedTerms({ connection: "default" })).toEqual([])
  })

  it("ignores an answer whose qname is not in the catalog", async () => {
    const mem = await setupMemory()
    persistLearnedTermFromResolution(
      { ...baseResolved, answer: "dim.Gone" },
      "top clients by revenue",
      "alice@corp",
      bootDeps()
    )
    expect(mem.listResolvedTerms({ connection: "default" })).toEqual([])
  })

  it("ignores clarification kinds that do not teach a term→table mapping", async () => {
    const mem = await setupMemory()
    persistLearnedTermFromResolution(
      { ...baseResolved, kind: "time-range", answer: "dim.Client" },
      "top clients by revenue",
      "alice@corp",
      bootDeps()
    )
    expect(mem.listResolvedTerms({ connection: "default" })).toEqual([])
  })

  it("never throws when boot deps are missing (no mssql/catalog)", async () => {
    const mem = await setupMemory()
    expect(() =>
      persistLearnedTermFromResolution(
        { ...baseResolved, answer: "dim.Client" },
        "top clients by revenue",
        null,
        {} as BootHostDeps
      )
    ).not.toThrow()
    expect(mem.listResolvedTerms({ connection: "default" })).toEqual([])
  })
})
