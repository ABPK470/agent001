import Database from "better-sqlite3"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { _migrate } from "../../infra/persistence/connection.js"
import * as db from "../../infra/persistence/sqlite.js"
import { loadPersistedConnectors } from "../../adapters/connectors/live-connectors.js"

beforeEach(() => {
  _migrate(new Database(":memory:"))
})

describe("connector persistence", () => {
  it("round-trips a connector through save / get / list / delete", () => {
    const now = new Date().toISOString()
    db.saveConnector({
      id: "dev",
      kind: "mssql",
      body_json: JSON.stringify({
        id: "dev",
        kind: "mssql",
        name: "dev",
        displayName: "Development",
        config: { host: "db-dev" },
        enabled: true,
        createdAt: now,
        updatedAt: now,
        updatedBy: null,
      }),
      enabled: 1,
      created_at: now,
      updated_at: now,
      updated_by: null,
    })

    expect(db.getConnector("dev")).toBeDefined()
    expect(db.countConnectors()).toBe(1)
    expect(db.listConnectors().map((r) => r.id)).toEqual(["dev"])

    db.deleteConnector("dev")
    expect(db.getConnector("dev")).toBeUndefined()
    expect(db.countConnectors()).toBe(0)
  })
})

describe("loadPersistedConnectors seeding", () => {
  let projectRoot: string

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "mia-conn-seed-"))
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
  })

  it("seeds from deploy/connectors/connectors.json when the table is empty", () => {
    mkdirSync(join(projectRoot, "deploy", "connectors"), { recursive: true })
    writeFileSync(
      join(projectRoot, "deploy", "connectors", "connectors.json"),
      JSON.stringify({
        version: 1,
        connectors: [
          {
            id: "dev",
            kind: "mssql",
            name: "dev",
            displayName: "Development",
            enabled: true,
            config: { host: "db-dev", database: "mymi", user: "sa", password: "pw" },
          },
        ],
      }),
    )

    const result = loadPersistedConnectors(projectRoot)
    expect(result.source).toBe("file")
    expect(result.seeded).toBe(true)
    expect(result.connectors.map((c) => c.id)).toEqual(["dev"])
    expect(result.connectors[0]!.kind).toBe("mssql")
    expect(result.connectors[0]!.config["host"]).toBe("db-dev")
    expect(db.countConnectors()).toBe(1)
  })

  it("leaves the table empty when no seed file exists", () => {
    const result = loadPersistedConnectors(projectRoot)
    expect(result.source).toBe("none")
    expect(result.seeded).toBe(true)
    expect(result.connectors).toEqual([])
    expect(db.countConnectors()).toBe(0)
  })

  it("reads from the db (no re-seed) once rows exist", () => {
    mkdirSync(join(projectRoot, "deploy", "connectors"), { recursive: true })
    writeFileSync(
      join(projectRoot, "deploy", "connectors", "connectors.json"),
      JSON.stringify({
        version: 1,
        connectors: [
          {
            id: "dev",
            kind: "mssql",
            name: "dev",
            config: { host: "db-dev", database: "mymi" },
          },
        ],
      }),
    )
    loadPersistedConnectors(projectRoot)
    const second = loadPersistedConnectors(projectRoot)
    expect(second.source).toBe("db")
    expect(second.seeded).toBe(false)
    expect(db.countConnectors()).toBe(1)
  })
})
