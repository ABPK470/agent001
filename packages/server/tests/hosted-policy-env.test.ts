/**
 * Env-aware policy facts + sync-environment permission defaults.
 *
 * Policies (deploy/policies/defaults.json + UI) are the allow/deny/approve rail.
 * SyncEnvironment permission fields feed orchestration gates only — they no
 * longer synthesize parallel policy_configs rows.
 */

import {
  extractToolFacts,
  type Step,
} from "@mia/agent"
import { withPermissionDefaults } from "@mia/sync"
import { describe, expect, it } from "vitest"

function makeStep(action: string, input: Record<string, unknown> = {}): Step {
  return {
    id: "s1",
    definitionId: "s1",
    name: action,
    action,
    input,
    condition: null,
    onError: "fail",
    status: "pending" as Step["status"],
    order: 0,
    output: {},
    error: null,
    startedAt: null,
    completedAt: null,
  }
}

describe("extractToolFacts — connection synonym", () => {
  it("reads connection as dbEnvironment when environment is absent", () => {
    const facts = extractToolFacts(makeStep("query_mssql", { connection: "prod", query: "SELECT 1" }))
    expect(facts.dbEnvironment).toBe("prod")
  })

  it("prefers environment over connection when both are set", () => {
    const facts = extractToolFacts(
      makeStep("query_mssql", { environment: "uat", connection: "prod", query: "SELECT 1" }),
    )
    expect(facts.dbEnvironment).toBe("uat")
  })
})

describe("extractToolFacts — command normalization", () => {
  it("collapses internal whitespace runs so spread-out tokens still match", () => {
    const facts = extractToolFacts(makeStep("run_command", { command: "git   \t  push   origin main" }))
    expect(facts.command).toBe("git push origin main")
  })
})

describe("extractToolFacts — sync tools", () => {
  it("classifies sync_preview with target=prod", () => {
    const facts = extractToolFacts(
      makeStep("sync_preview", { entityType: "content", source: "dev", target: "prod" }),
    )
    expect(facts.dbEnvironment).toBe("prod")
    expect(facts.dbOperation).toBe("sync_preview")
  })

  it("classifies sync_execute with target=uat", () => {
    const facts = extractToolFacts(makeStep("sync_execute", { planId: "p1", confirm: true, target: "uat" }))
    expect(facts.dbEnvironment).toBe("uat")
    expect(facts.dbOperation).toBe("sync_execute")
  })
})

describe("withPermissionDefaults", () => {
  it("uat is read-only with DML+DDL denied by default", () => {
    const e = withPermissionDefaults({ name: "uat" })
    expect(e.defaultAccessMode).toBe("read_only")
    expect(e.denyDml).toBe(true)
    expect(e.denyDdl).toBe(true)
    expect(e.approvalRequiredOperations).toEqual([])
  })

  it("prod is read-only with DML+DDL denied by default", () => {
    const e = withPermissionDefaults({ name: "prod" })
    expect(e.defaultAccessMode).toBe("read_only")
    expect(e.denyDml).toBe(true)
    expect(e.denyDdl).toBe(true)
  })

  it("dev is read-write with no DML/DDL deny by default", () => {
    const e = withPermissionDefaults({ name: "dev" })
    expect(e.defaultAccessMode).toBe("read_write")
    expect(e.denyDml).toBe(false)
    expect(e.denyDdl).toBe(false)
  })

  it("explicit denyDml on a dev env wins over the env-shape default", () => {
    const e = withPermissionDefaults({ name: "dev", denyDml: true })
    expect(e.denyDml).toBe(true)
  })
})
