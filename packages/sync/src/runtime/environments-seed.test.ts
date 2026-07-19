import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { loadSyncEnvironments } from "./environments.js"

describe("loadSyncEnvironments seed", () => {
  it("preserves connectorId from sync-environments.json (Bug A)", () => {
    const root = mkdtempSync(join(tmpdir(), "mia-env-seed-"))
    const dir = join(root, "deploy", "sync")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "sync-environments.json"),
      JSON.stringify({
        version: 1,
        environments: [
          {
            name: "dev",
            connectorId: "dev",
            displayName: "DEV",
            color: "blue",
            role: "both",
            ringOrder: 0,
            allowedSyncEnvironments: [],
          },
          {
            name: "uat",
            connectorId: "uat",
            displayName: "UAT",
            color: "teal",
            role: "both",
            ringOrder: 1,
            allowedSyncEnvironments: ["dev"],
          },
        ],
      }),
      "utf-8",
    )

    const loaded = loadSyncEnvironments(root, [])
    expect(loaded.source).toBe("file")
    expect(loaded.environments.map((e) => ({ name: e.name, connectorId: e.connectorId }))).toEqual([
      { name: "dev", connectorId: "dev" },
      { name: "uat", connectorId: "uat" },
    ])
  })

  it("sets connectorId from connection name on mssql fallback", () => {
    const root = mkdtempSync(join(tmpdir(), "mia-env-fb-"))
    const loaded = loadSyncEnvironments(root, [{ name: "lab" }])
    expect(loaded.source).toBe("mssql")
    expect(loaded.environments[0]?.connectorId).toBe("lab")
  })
})
