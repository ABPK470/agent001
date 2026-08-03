import Database from "better-sqlite3"
import { beforeEach, describe, expect, it } from "vitest"
import { _migrate } from "../../../infra/persistence/adapters/sqlite/connection.js"
import * as db from "../../../infra/persistence/sqlite.js"
import { importConnectors, planConnectorsImport } from "./import-connectors.js"

describe("importConnectors gate", () => {
  beforeEach(() => {
    _migrate(new Database(":memory:"))
  })

  it("dry-run classifies create vs update and does not write", async () => {
    const now = new Date().toISOString()
    await db.saveConnector({
      id: "dev",
      kind: "mssql",
      body_json: JSON.stringify({
        id: "dev",
        kind: "mssql",
        name: "dev",
        displayName: "DEV",
        enabled: false,
        config: {
          host: "sqldev",
          port: 1433,
          database: "mymi",
          user: "admin",
          password: "abcd",
          domain: "corp",
          encrypt: true,
          trustServerCertificate: true,
          knowledgePath: null,
        },
        createdAt: now,
        updatedAt: now,
        updatedBy: "seed",
      }),
      enabled: 0,
      created_at: now,
      updated_at: now,
      updated_by: "seed",
    })

    const result = await importConnectors({
      version: 1,
      connectors: [
        {
          id: "dev",
          kind: "mssql",
          name: "dev",
          displayName: "DEV",
          enabled: false,
          config: {
            host: "sqldev2",
            port: 1433,
            database: "mymi",
            user: "admin",
            password: "abcd",
            domain: "corp",
            encrypt: true,
            trustServerCertificate: true,
            knowledgePath: null,
          },
        },
        {
          id: "uat",
          kind: "mssql",
          name: "uat",
          displayName: "UAT",
          enabled: false,
          config: {
            host: "sqluat",
            port: 1433,
            database: "mymi",
            user: "admin",
            password: "abcd",
            domain: "corp",
            encrypt: true,
            trustServerCertificate: true,
            knowledgePath: null,
          },
        },
      ],
      dryRun: true,
      reason: "preview",
      actor: "admin@test",
    })

    expect(result.ok).toBe(true)
    expect(result.dryRun).toBe(true)
    expect(result.applied).toBe(false)
    expect(result.impact.updates).toContain("dev")
    expect(result.impact.creates).toContain("uat")
    expect(await db.getConnector("uat")).toBeFalsy()
  })

  it("fail-closed on invalid config and refuses apply without reason", async () => {
    const plan = await planConnectorsImport({
      version: 1,
      connectors: [
        {
          id: "bad",
          kind: "mssql",
          name: "bad",
          config: { host: "", port: 1433 },
        },
      ],
    })
    expect(plan.ok).toBe(false)
    expect(plan.errors.length).toBeGreaterThan(0)

    const blocked = await importConnectors({
      version: 1,
      connectors: [
        {
          id: "uat",
          kind: "mssql",
          name: "uat",
          displayName: "UAT",
          enabled: false,
          config: {
            host: "sqluat",
            port: 1433,
            database: "mymi",
            user: "admin",
            password: "abcd",
            domain: "corp",
            encrypt: true,
            trustServerCertificate: true,
            knowledgePath: null,
          },
        },
      ],
      dryRun: false,
      reason: "  ",
      actor: "admin@test",
    })
    expect(blocked.ok).toBe(false)
    expect(blocked.applied).toBe(false)
    expect(blocked.errors.some((e) => e.includes("reason"))).toBe(true)
    expect(await db.getConnector("uat")).toBeFalsy()
  })

  it("applies when valid with reason", async () => {
    const result = await importConnectors({
      version: 1,
      connectors: [
        {
          id: "uat",
          kind: "mssql",
          name: "uat",
          displayName: "UAT",
          enabled: false,
          config: {
            host: "sqluat",
            port: 1433,
            database: "mymi",
            user: "admin",
            password: "abcd",
            domain: "corp",
            encrypt: true,
            trustServerCertificate: true,
            knowledgePath: null,
          },
        },
      ],
      dryRun: false,
      reason: "seed uat",
      actor: "admin@test",
    })
    expect(result.ok).toBe(true)
    expect(result.applied).toBe(true)
    expect(await db.getConnector("uat")).toBeTruthy()
  })
})
