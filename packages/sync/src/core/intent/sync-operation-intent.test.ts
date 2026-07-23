import { describe, expect, it } from "vitest"
import {
  buildEntityTypeAliasMap,
  parseSyncOperationIntent,
} from "./sync-operation-intent.js"
import type { PublishedSyncDefinition } from "@mia/shared-types"
import { withPermissionDefaults } from "../eligibility/environments.js"

function stubDefinition(id: string, displayName: string): PublishedSyncDefinition {
  return {
    schemaVersion: 1,
    id,
    displayName,
    description: "",
    rootTable: "core.Contract",
    idColumn: "id",
    labelColumn: "name",
    selfJoinColumn: null,
    legacy: { pipelineId: null, entrySproc: null },
    governance: { freezeWindowIds: [] },
    strategy: { strategyId: "x", strategyVersion: "latest" },
    bindings: { serviceProfileRef: "default", environmentPolicyRef: "default" },
    ownership: { team: "t", owner: null, reviewStatus: "reviewed", notes: [] },
    metadata: { tables: [], executionOrder: [], reverseOrder: [], discrepancies: [] },
    executionFlow: { steps: [] },
    provenance: { kind: "manual" },
    publishedAt: "2026-01-01T00:00:00.000Z",
    publishedVersion: "1"
  }
}

const definitions = [
  stubDefinition("contract", "Contract"),
  stubDefinition("pipelineActivity", "Pipeline Activity"),
  stubDefinition("gateMetadata", "Gate Metadata")
]

const environments = [
  withPermissionDefaults({ name: "uat", displayName: "UAT", role: "source", ringOrder: 1 }),
  withPermissionDefaults({ name: "dev", displayName: "Development", role: "target", ringOrder: 0 })
]

describe("parseSyncOperationIntent", () => {
  it("parses sync contract <name> from uat to dev", () => {
    const intent = parseSyncOperationIntent(
      "sync contract abcd from uat to dev",
      definitions,
      environments
    )
    expect(intent).not.toBeNull()
    expect(intent!.entityType).toBe("contract")
    expect(intent!.entityQuery).toBe("abcd")
    expect(intent!.source).toBe("uat")
    expect(intent!.target).toBe("dev")
    expect(intent!.reservedTokens.has("abcd")).toBe(true)
    expect(intent!.reservedTokens.has("contract")).toBe(true)
  })

  it("parses synchronize with case-insensitive environments", () => {
    const intent = parseSyncOperationIntent(
      "please synchronize contract ACSRawTest from UAT to DEV",
      definitions,
      environments
    )
    expect(intent?.entityQuery).toBe("ACSRawTest")
    expect(intent?.source).toBe("uat")
    expect(intent?.target).toBe("dev")
  })

  it("resolves pipeline alias to pipelineActivity definition", () => {
    const intent = parseSyncOperationIntent(
      "sync pipeline MyPipe from uat to dev",
      definitions,
      environments
    )
    expect(intent?.entityType).toBe("pipelineActivity")
    expect(intent?.entityQuery).toBe("MyPipe")
  })

  it("parses numeric contract id without name search", () => {
    const intent = parseSyncOperationIntent(
      "sync contract 2545 from uat to dev",
      definitions,
      environments
    )
    expect(intent?.entityId).toBe("2545")
    expect(intent?.entityQuery).toBeNull()
  })

  it("returns null without sync verb or env route", () => {
    expect(parseSyncOperationIntent("show contract abcd", definitions, environments)).toBeNull()
    expect(parseSyncOperationIntent("sync contract abcd", definitions, environments)).toBeNull()
  })
})

describe("buildEntityTypeAliasMap", () => {
  it("maps display name tokens without hardcoding", () => {
    const map = buildEntityTypeAliasMap(definitions)
    expect(map.get("contract")).toBe("contract")
    expect(map.get("pipeline")).toBe("pipelineActivity")
    expect(map.get("gate")).toBe("gateMetadata")
  })
})
