import Database from "better-sqlite3"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, afterEach, describe, expect, it } from "vitest"

import { _migrate } from "../../infra/persistence/connection.js"
import * as db from "../../infra/persistence/sqlite.js"
import { loadPersistedConnectors } from "./state/live-connectors.js"
import { mssqlConfigsFromConnectors } from "./state/mssql-from-connectors.js"
import type { ConfigureMssqlConnection } from "@mia/agent"

let projectRoot: string

beforeEach(() => {
  _migrate(new Database(":memory:"))
  projectRoot = mkdtempSync(join(tmpdir(), "mia-connectors-e2e-"))
})

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true })
})

describe("mssqlConfigsFromConnectors (Phase 2 source of truth)", () => {
  it("round-trips boot connections through the connectors DB preserving every field + knowledge", () => {
    const knowledgePath = "./knowledge.md"
    writeFileSync(join(projectRoot, "knowledge.md"), "# Knowledge\nSchema guidance for dev.")
    const dev: ConfigureMssqlConnection = {
      name: "dev",
      server: "db-dev",
      port: 1433,
      user: "sa",
      password: "pw",
      database: "mymi_dev",
      domain: "corp",
      options: { encrypt: true, trustServerCertificate: true },
      writeEnabled: true,
      knowledgePath,
      knowledge: null,
    }
    const prod: ConfigureMssqlConnection = {
      name: "prod",
      server: "db-prod",
      port: 1433,
      user: "sa",
      password: "pw2",
      database: "mymi_prod",
      options: { encrypt: true, trustServerCertificate: false },
      writeEnabled: false,
      knowledgePath: null,
      knowledge: null,
    }

    // 1. Seed the connectors DB from the legacy boot connections (one-time bridge).
    const seeded = loadPersistedConnectors(projectRoot, [dev, prod])
    expect(seeded.source).toBe("mssql")
    expect(seeded.connectors.map((c) => c.name)).toEqual(["dev", "prod"])
    expect(seeded.connectors[0]!.config["knowledgePath"]).toBe(knowledgePath)

    // 2. Flip the source: build the LIVE mssql configs from the persisted connectors.
    const configs = mssqlConfigsFromConnectors(seeded.connectors, projectRoot)

    expect(configs.map((c) => c.name)).toEqual(["dev", "prod"])
    const gotDev = configs[0]!
    expect(gotDev.server).toBe("db-dev")
    expect(gotDev.port).toBe(1433)
    expect(gotDev.database).toBe("mymi_dev")
    expect(gotDev.user).toBe("sa")
    expect(gotDev.password).toBe("pw")
    expect(gotDev.domain).toBe("corp")
    expect(gotDev.options?.encrypt).toBe(true)
    expect(gotDev.options?.trustServerCertificate).toBe(true)
    expect(gotDev.writeEnabled).toBe(true)
    expect(gotDev.knowledgePath).toBe(knowledgePath)
    expect(gotDev.knowledge).toBe("# Knowledge\nSchema guidance for dev.")

    const gotProd = configs[1]!
    expect(gotProd.knowledgePath).toBeNull()
    expect(gotProd.knowledge).toBeNull()
    expect(gotProd.options?.trustServerCertificate).toBe(false)
  })

  it("skips disabled connectors and non-mssql kinds", () => {
    const now = new Date().toISOString()
    db.saveConnector({
      id: "off",
      kind: "mssql",
      body_json: JSON.stringify({
        id: "off",
        kind: "mssql",
        name: "off",
        displayName: "Off",
        config: { host: "db-off", database: "mymi", user: "sa", password: "x" },
        enabled: false,
        createdAt: now,
        updatedAt: now,
        updatedBy: null,
      }),
      enabled: 0,
      created_at: now,
      updated_at: now,
      updated_by: null,
    })
    db.saveConnector({
      id: "pg",
      kind: "postgres",
      body_json: JSON.stringify({
        id: "pg",
        kind: "postgres",
        name: "pg",
        displayName: "PG",
        config: { host: "db-pg" },
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

    const configs = mssqlConfigsFromConnectors(
      db.listConnectors().map((r) => JSON.parse(r.body_json)),
      projectRoot,
    )
    expect(configs).toEqual([])
  })

  it("falls back to schema defaults for missing optional fields", () => {
    const now = new Date().toISOString()
    db.saveConnector({
      id: "minimal",
      kind: "mssql",
      body_json: JSON.stringify({
        id: "minimal",
        kind: "mssql",
        name: "minimal",
        displayName: "Minimal",
        config: { host: "db-min", database: "mymi" },
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

    const [got] = mssqlConfigsFromConnectors(
      db.listConnectors().map((r) => JSON.parse(r.body_json)),
      projectRoot,
    )
    expect(got.name).toBe("minimal")
    expect(got.port).toBe(1433)
    expect(got.database).toBe("mymi")
    expect(got.user).toBe("sa")
    expect(got.password).toBe("")
    expect(got.options?.encrypt).toBe(true)
    expect(got.writeEnabled).toBe(false)
    expect(got.knowledge).toBeNull()
  })
})
