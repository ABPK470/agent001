import Database from "better-sqlite3"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, afterEach, describe, expect, it } from "vitest"

import { _migrate } from "../../infra/persistence/adapters/sqlite/connection.js"
import * as db from "../../infra/persistence/sqlite.js"
import { mssqlConfigsFromConnectors } from "../../adapters/connectors/mssql-from-connectors.js"

let projectRoot: string

beforeEach(() => {
  _migrate(new Database(":memory:"))
  projectRoot = mkdtempSync(join(tmpdir(), "mia-connectors-e2e-"))
})

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true })
})

async function saveMssqlConnector(
  id: string,
  config: Record<string, string | number | boolean | null>,
  enabled = true,
): Promise<void> {
  const now = new Date().toISOString()
  await db.saveConnector({
    id,
    kind: "mssql",
    body_json: JSON.stringify({
      id,
      kind: "mssql",
      name: id,
      displayName: id,
      config,
      enabled,
      createdAt: now,
      updatedAt: now,
      updatedBy: null,
    }),
    enabled: enabled ? 1 : 0,
    created_at: now,
    updated_at: now,
    updated_by: null,
  })
}

describe("mssqlConfigsFromConnectors", () => {
  it("builds live mssql configs from persisted connectors preserving every field + knowledge", async () => {
    const knowledgePath = "./knowledge.md"
    writeFileSync(join(projectRoot, "knowledge.md"), "# Knowledge\nSchema guidance for dev.")
    await saveMssqlConnector("dev", {
      host: "db-dev",
      port: 1433,
      database: "mymi_dev",
      user: "sa",
      password: "pw",
      domain: "corp",
      encrypt: true,
      trustServerCertificate: true,
      knowledgePath,
    })
    await saveMssqlConnector("prod", {
      host: "db-prod",
      port: 1433,
      database: "mymi_prod",
      user: "sa",
      password: "pw2",
      encrypt: true,
      trustServerCertificate: false,
      knowledgePath: null,
    })

    const configs = mssqlConfigsFromConnectors(
      (await db.listConnectors()).map((r) => JSON.parse(r.body_json)),
      projectRoot,
    )

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
    expect(gotDev.knowledgePath).toBe(knowledgePath)
    expect(gotDev.knowledge).toBe("# Knowledge\nSchema guidance for dev.")

    const gotProd = configs[1]!
    expect(gotProd.knowledgePath).toBeNull()
    expect(gotProd.knowledge).toBeNull()
    expect(gotProd.options?.trustServerCertificate).toBe(false)
  })

  it("skips disabled connectors and non-mssql kinds", async () => {
    await saveMssqlConnector("off", { host: "db-off", database: "mymi", user: "sa", password: "x" }, false)
    const now = new Date().toISOString()
    await db.saveConnector({
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
      (await db.listConnectors()).map((r) => JSON.parse(r.body_json)),
      projectRoot,
    )
    expect(configs).toEqual([])
  })

  it("falls back to schema defaults for missing optional fields", async () => {
    await saveMssqlConnector("minimal", { host: "db-min", database: "mymi" })

    const [got] = mssqlConfigsFromConnectors(
      (await db.listConnectors()).map((r) => JSON.parse(r.body_json)),
      projectRoot,
    )
    expect(got.name).toBe("minimal")
    expect(got.port).toBe(1433)
    expect(got.database).toBe("mymi")
    expect(got.user).toBe("sa")
    expect(got.password).toBe("")
    expect(got.options?.encrypt).toBe(true)
    expect(got.knowledge).toBeNull()
  })
})
