import Database from "better-sqlite3"
import { beforeEach, describe, expect, it } from "vitest"

import { _migrate } from "../../infra/persistence/connection.js"
import * as db from "../../infra/persistence/sqlite.js"
import { loadPersistedConnectors } from "./state/live-connectors.js"
import type { ConfigureMssqlConnection } from "@mia/agent"

beforeEach(() => {
  _migrate(new Database(":memory:"))
})

const mssqlDev: ConfigureMssqlConnection = {
  name: "dev",
  server: "db-dev",
  port: 1433,
  user: "sa",
  password: "pw",
  database: "mymi_dev",
  options: { encrypt: true, trustServerCertificate: true },
}

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
  it("synthesises one mssql connector per boot connection when the table is empty", () => {
    const result = loadPersistedConnectors("/nonexistent-project-root", [mssqlDev])
    expect(result.source).toBe("mssql")
    expect(result.seeded).toBe(true)
    expect(result.connectors.map((c) => c.id)).toEqual(["dev"])
    expect(result.connectors[0]!.kind).toBe("mssql")
    expect(result.connectors[0]!.config["host"]).toBe("db-dev")
    // persisted to the table
    expect(db.countConnectors()).toBe(1)
  })

  it("reads from the db (no re-seed) once rows exist", () => {
    loadPersistedConnectors("/nonexistent-project-root", [mssqlDev])
    const second = loadPersistedConnectors("/nonexistent-project-root", [mssqlDev])
    expect(second.source).toBe("db")
    expect(second.seeded).toBe(false)
    expect(db.countConnectors()).toBe(1)
  })
})
