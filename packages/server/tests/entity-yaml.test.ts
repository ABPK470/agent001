/**
 * entity-yaml round-trip tests — verifies that an EntityDefinition →
 * YAML → EntityDefinition cycle preserves every structural field.
 *
 * Server-stamped fields (version, versionLabel, createdAt, createdBy,
 * retiredAt) are NOT preserved on import — the caller stamps those —
 * so we ignore them when comparing.
 */

import type { EntityDefinition } from "@mia/sync"
import { describe, expect, it } from "vitest"
import {
  formatEntitiesYaml,
  formatEntityYaml,
  parseEntitiesYaml,
  parseEntityYaml
} from "../src/adapters/sync/entity-yaml.js"

const FULL_DEF: EntityDefinition = {
  id: "contract",
  tenantId: "_default",
  displayName: "Contract",
  description: "Contract root entity",
  rootTable: "dbo.Contract",
  idColumn: "ContractId",
  labelColumn: "Title",
  selfJoinColumn: null,
  tables: [
    {
      name: "dbo.Contract",
      executionOrder: 1,
      scope: { kind: "rootPk", column: "ContractId" },
      scd2Override: null,
      verified: true,
      archiveTable: "dboArchive.Contract",
      note: null,
      provenance: { kind: "manual" },
      scopeColumn: "ContractId",
      source: "fk+pipeline",
      groundedByPipeline: true,
      enabledByDefault: true,
      userControllable: false
    },
    {
      name: "dbo.ContractLineItem",
      executionOrder: 2,
      scope: {
        kind: "fkPath",
        through: [
          {
            table: "dbo.ContractLineItem",
            fromColumn: "ContractId",
            toColumn: "ContractLineItemId"
          }
        ]
      },
      scd2Override: null,
      verified: true,
      archiveTable: null,
      note: "downstream",
      provenance: { kind: "manual" },
      scopeColumn: null,
      source: "fk-only",
      groundedByPipeline: false,
      enabledByDefault: false,
      userControllable: true
    }
  ],
  policies: {
    approvalPolicyId: null,
    freezeWindowIds: ["month-end"],
    riskMultiplier: 1.5
  },
  scd2: {
    strategyId: "mymi-scd2",
    strategyVersion: "latest",
    entityOverride: null
  },
  lineageRefs: [],
  provenance: { kind: "legacy-migration", legacyPipelineId: 42 },
  legacyEntrySproc: "dbo.uspSyncContract",
  reverseOrder: ["dbo.ContractLineItem", "dbo.Contract"],
  discrepancies: [],
  version: 1,
  versionLabel: null,
  createdBy: "test",
  reason: "init",
  createdAt: "2025-01-01T00:00:00.000Z",
  retiredAt: null
}

// Fields the import path does not populate (server stamps them).
function stripServerStamped(
  def: EntityDefinition
): Omit<EntityDefinition, "version" | "versionLabel" | "createdAt" | "createdBy" | "reason" | "retiredAt"> {
  const { version, versionLabel, createdAt, createdBy, reason, retiredAt, ...rest } = def
  void version
  void versionLabel
  void createdAt
  void createdBy
  void reason
  void retiredAt
  rest.policies = {
    freezeWindowIds: rest.policies.freezeWindowIds,
    riskMultiplier: rest.policies.riskMultiplier
  }
  return rest
}

describe("entity-yaml round-trip", () => {
  it("preserves all structural fields through format → parse", () => {
    const yaml = formatEntityYaml(FULL_DEF)
    const parsed = parseEntityYaml(yaml)
    expect(parsed.ok).toBe(true)
    expect(parsed.def).not.toBeNull()
    expect(stripServerStamped(parsed.def!)).toEqual(stripServerStamped(FULL_DEF))
  })

  it("does not round-trip approvalPolicyId because runtime ignores it", () => {
    const yaml = formatEntityYaml({
      ...FULL_DEF,
      policies: { ...FULL_DEF.policies, approvalPolicyId: "high-risk" }
    })
    const parsed = parseEntityYaml(yaml)
    expect(parsed.ok).toBe(true)
    expect(parsed.def?.policies).not.toHaveProperty("approvalPolicyId")
  })

  it("emits valid YAML for multi-doc bulk export", () => {
    const yaml = formatEntitiesYaml([FULL_DEF, { ...FULL_DEF, id: "dataset", displayName: "Dataset" }])
    const parsed = parseEntitiesYaml(yaml)
    expect(parsed).toHaveLength(2)
    expect(parsed.every((p) => p.ok)).toBe(true)
    expect(parsed[0]!.def!.id).toBe("contract")
    expect(parsed[1]!.def!.id).toBe("dataset")
  })

  it("reports a clear error on missing required field", () => {
    const yaml = "id: foo\ntenantId: _default"
    const parsed = parseEntityYaml(yaml)
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toMatch(/missing required field/)
  })

  it("reports yaml-parse-error on malformed yaml", () => {
    const yaml = "id: foo\n  : invalid:::"
    const parsed = parseEntityYaml(yaml)
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toBeTruthy()
  })

  it("ignores server-stamped fields when present in YAML", () => {
    const yaml = formatEntityYaml({ ...FULL_DEF, version: 99, createdBy: "should-be-ignored" })
    const parsed = parseEntityYaml(yaml)
    expect(parsed.ok).toBe(true)
    // Import returns a default version (caller will stamp it).
    expect(parsed.def!.id).toBe(FULL_DEF.id)
  })
})
