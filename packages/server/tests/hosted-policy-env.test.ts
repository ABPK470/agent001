/**
 * Phase 2 — env-aware policy facts and derived per-env rules.
 *
 * Locks the wins from the Phase 1A/2 implementation round:
 *   1. `extractToolFacts` reads `connection: "prod"` (today's tool-arg
 *      shape for `query_mssql`/`explore_mssql_schema`/`export_query_to_file`)
 *      as a synonym for `dbEnvironment`, so per-env selectors fire
 *      without changing tool inputs.
 *   2. Shell command extraction collapses internal whitespace runs so a
 *      "git    push" doesn't sneak past a `\bgit push\b` rule.
 *   3. Per-environment SyncEnvironment config produces the expected
 *      derived selector rules via {@link policyRulesFromEnvironments}.
 *   4. Locked-down envs (UAT/PROD) get safe defaults from
 *      {@link withPermissionDefaults}; DEV stays writable.
 */

import {
  extractToolFacts,
  PolicyEffect,
  PolicyViolationError,
  RulePolicyEvaluator,
  type AgentRun,
  type HostedPolicyContext,
  type Step
} from "@mia/agent"
import { withPermissionDefaults } from "@mia/sync"
import { describe, expect, it } from "vitest"
import { policyRulesFromEnvironments } from "../src/api/policies/domain/hosted-defaults.js"

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
    completedAt: null
  }
}

const HOSTED: HostedPolicyContext = {
  runId: "r1",
  runMode: "hosted",
  role: "hosted_user",
  sandboxRoot: "/tmp/sb"
}

async function evaluate(
  ev: RulePolicyEvaluator,
  step: Step
): Promise<{ approval: string | null; error?: PolicyViolationError }> {
  const run = { id: "r1" } as AgentRun
  try {
    const approval = await ev.evaluatePreStep(run, step, HOSTED)
    return { approval }
  } catch (err) {
    if (err instanceof PolicyViolationError) return { approval: null, error: err }
    throw err
  }
}

// ── Fact extraction ──────────────────────────────────────────────

describe("extractToolFacts — environment from connection arg", () => {
  it('treats connection="prod" as dbEnvironment=prod for query_mssql', () => {
    const facts = extractToolFacts(makeStep("query_mssql", { connection: "prod", query: "SELECT 1" }))
    expect(facts.dbEnvironment).toBe("prod")
    expect(facts.dbOperation).toBe("query_read")
  })

  it('treats connection="uat" as dbEnvironment=uat for explore_mssql_schema', () => {
    const facts = extractToolFacts(makeStep("explore_mssql_schema", { connection: "uat", schema: "agent" }))
    expect(facts.dbEnvironment).toBe("uat")
  })

  it("classifies UPDATE as dml even when arrived via connection=prod", () => {
    const facts = extractToolFacts(
      makeStep("query_mssql", { connection: "prod", query: "UPDATE t SET x = 1" })
    )
    expect(facts.dbEnvironment).toBe("prod")
    expect(facts.dbOperation).toBe("dml")
  })

  it("ignores connection values that are not well-known env keys", () => {
    const facts = extractToolFacts(
      makeStep("query_mssql", { connection: "some-other-server", query: "SELECT 1" })
    )
    expect(facts.dbEnvironment).toBeUndefined()
  })

  it("explicit `environment` arg still wins over `connection`", () => {
    const facts = extractToolFacts(
      makeStep("query_mssql", { environment: "uat", connection: "prod", query: "SELECT 1" })
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

// ── Derived per-env rules ────────────────────────────────────────

describe("policyRulesFromEnvironments", () => {
  it("emits deny-DML and deny-DDL rules for a UAT env with denyDml + denyDdl", () => {
    const env = withPermissionDefaults({ name: "uat" })
    const rules = policyRulesFromEnvironments([env])
    const denies = rules
      .filter((r) => r.effect === PolicyEffect.Deny)
      .map((r) => r.name)
      .sort()
    expect(denies).toContain("env_uat_deny_dml")
    expect(denies).toContain("env_uat_deny_ddl")
    const approvals = rules.filter((r) => r.effect === PolicyEffect.RequireApproval).map((r) => r.name)
    expect(approvals).toHaveLength(0)
  })

  it("emits approval rules only when approvalRequiredOperations is explicitly configured", () => {
    const env = withPermissionDefaults({ name: "uat", approvalRequiredOperations: ["sync_execute"] })
    const rules = policyRulesFromEnvironments([env])
    const approvals = rules.filter((r) => r.effect === PolicyEffect.RequireApproval).map((r) => r.name)
    expect(approvals).toContain("env_uat_approval_sync_execute")
  })

  it("emits an explicit ALLOW rule when DEV opts in to DML via allowedOperations", () => {
    const env = withPermissionDefaults({
      name: "dev",
      allowedOperations: ["query_read", "schema_introspect", "sync_preview", "sync_execute", "dml"]
    })
    const rules = policyRulesFromEnvironments([env])
    const allows = rules.filter((r) => r.effect === PolicyEffect.Allow).map((r) => r.name)
    expect(allows).toContain("env_dev_allow_dml")
  })

  it("does NOT emit allow-dml when denyDml is also set (deny wins, allow is suppressed)", () => {
    const env = withPermissionDefaults({ name: "dev", denyDml: true, allowedOperations: ["dml"] })
    const rules = policyRulesFromEnvironments([env])
    expect(rules.find((r) => r.name === "env_dev_allow_dml")).toBeUndefined()
    expect(rules.find((r) => r.name === "env_dev_deny_dml")).toBeDefined()
  })

  it("skips envs whose name is not one of dev/uat/prod (selector engine only knows three keys)", () => {
    const env = withPermissionDefaults({ name: "qa" })
    expect(policyRulesFromEnvironments([env])).toHaveLength(0)
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

// ── End-to-end: derived rules fire under the engine ──────────────

describe("derived per-env rules wired into the policy engine", () => {
  it("connection=prod + UPDATE -> denied by env_prod_deny_dml_query_mssql", async () => {
    const ev = new RulePolicyEvaluator()
    const env = withPermissionDefaults({ name: "prod" })
    for (const r of policyRulesFromEnvironments([env])) ev.addRule(r)
    // Without the cross-env mssql_* allow we still need a baseline allow
    // for the query_read case to NOT default-deny in hosted mode. The
    // dml case should hit the explicit deny first regardless.
    ev.addRule({
      name: "baseline_allow_query_mssql",
      effect: PolicyEffect.Allow,
      condition: "selectors",
      parameters: { selectors: { tool: "query_mssql" }, priority: 1 }
    })
    const denied = await evaluate(
      ev,
      makeStep("query_mssql", { connection: "prod", query: "UPDATE t SET x = 1" })
    )
    expect(denied.error).toBeInstanceOf(PolicyViolationError)
    expect(denied.error?.message).toMatch(/denyDml|deny_dml/i)

    const ok = await evaluate(ev, makeStep("query_mssql", { connection: "prod", query: "SELECT 1" }))
    expect(ok.error).toBeUndefined()
  })
})
