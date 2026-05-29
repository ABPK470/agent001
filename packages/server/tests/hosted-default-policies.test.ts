/**
 * Hosted-default policy rule tests.
 *
 * Validates the curated rule set behaves as designed when seeded into the
 * agent's selector policy engine. Mirrors the deployment seeding path
 * (orchestrator loads rules into `services.policyEvaluator` for hosted
 * runs).
 */

import {
    PolicyViolationError,
    RulePolicyEvaluator,
    type AgentRun,
    type HostedPolicyContext,
    type Step
} from "@mia/agent"
import { describe, expect, it } from "vitest"
import { hostedDefaultPolicyRules } from "../src/domain/policy/hosted-defaults.js"

function makeStep(action: string, input: Record<string, unknown> = {}): Step {
  return {
    id:           "s1",
    definitionId: "s1",
    name:         action,
    action,
    input,
    condition:    null,
    onError:      "fail",
    status:       "pending" as Step["status"],
    order:        0,
    output:       {},
    error:        null,
    startedAt:    null,
    completedAt:  null,
  }
}

function hostedCtx(over: Partial<HostedPolicyContext> = {}): HostedPolicyContext {
  return {
    runId:       "r1",
    runMode:     "hosted",
    role:        "hosted_user",
    sandboxRoot: "/tmp/sb",
    ...over,
  }
}

function buildHostedEvaluator(): RulePolicyEvaluator {
  const ev = new RulePolicyEvaluator()
  for (const rule of hostedDefaultPolicyRules()) ev.addRule(rule)
  return ev
}

async function evaluate(
  evaluator: RulePolicyEvaluator,
  step: Step,
  ctx: HostedPolicyContext,
): Promise<{ approval: string | null; error?: PolicyViolationError }> {
  const run = { id: "r1" } as AgentRun
  try {
    const approval = await evaluator.evaluatePreStep(run, step, ctx)
    return { approval }
  } catch (err) {
    if (err instanceof PolicyViolationError) return { approval: null, error: err }
    throw err
  }
}

describe("hosted default policy rules", () => {
  it("allows reads/writes inside the sandbox", async () => {
    const ev = buildHostedEvaluator()
    const read = await evaluate(ev, makeStep("read_file", { path: "/tmp/sb/notes.txt" }), hostedCtx())
    expect(read.error).toBeUndefined()
    const write = await evaluate(ev, makeStep("write_file", { path: "/tmp/sb/out.csv", content: "x" }), hostedCtx())
    expect(write.error).toBeUndefined()
  })

  it("denies reads and writes against the application workspace", async () => {
    const ev = buildHostedEvaluator()
    const read = await evaluate(ev, makeStep("read_file", { path: "workspace://src/secret.ts" }), hostedCtx())
    expect(read.error?.message).toMatch(/workspace/)
    const write = await evaluate(ev, makeStep("write_file", { path: "/etc/passwd", content: "x" }), hostedCtx())
    expect(write.error).toBeInstanceOf(PolicyViolationError)
  })

  it("allows ordinary shell commands but blocks privileged tokens", async () => {
    const ev = buildHostedEvaluator()
    const ok = await evaluate(ev, makeStep("run_command", { command: "ls -la" }), hostedCtx())
    expect(ok.error).toBeUndefined()
    const denied = await evaluate(ev, makeStep("run_command", { command: "sudo rm -rf /" }), hostedCtx())
    expect(denied.error?.message).toMatch(/privileged|destructive/)
  })

  it("allows MSSQL reads on UAT and PROD but blocks UAT/PROD DML", async () => {
    const ev = buildHostedEvaluator()
    const uatRead  = await evaluate(ev, makeStep("mssql_query", { environment: "uat",  sql: "SELECT 1" }), hostedCtx())
    const prodRead = await evaluate(ev, makeStep("mssql_query", { environment: "prod", sql: "SELECT 1" }), hostedCtx())
    expect(uatRead.error).toBeUndefined()
    expect(prodRead.error).toBeUndefined()

    const uatDml  = await evaluate(ev, makeStep("mssql_query", { environment: "uat",  sql: "UPDATE t SET x=1" }), hostedCtx())
    const prodDml = await evaluate(ev, makeStep("mssql_query", { environment: "prod", sql: "INSERT INTO t VALUES (1)" }), hostedCtx())
    expect(uatDml.error?.message).toMatch(/UAT/)
    expect(prodDml.error?.message).toMatch(/PROD/)
  })

  it("allows DEV DML through default-deny for operator override (no explicit rule for DEV DML)", async () => {
    // The defaults intentionally do not define a DEV DML rule. Hosted
    // default-deny will still block it unless the operator explicitly opts
    // in via a DB-stored rule. This test documents that contract.
    const ev = buildHostedEvaluator()
    const devDml = await evaluate(ev, makeStep("mssql_query", { environment: "dev", sql: "UPDATE t SET x=1" }), hostedCtx())
    expect(devDml.error?.message).toMatch(/hosted_default_deny/)
  })

  it("requires approval for sync_execute and outbound fetch", async () => {
    const ev = buildHostedEvaluator()
    const sync = await evaluate(ev, makeStep("sync_execute", { planId: "p1" }), hostedCtx())
    expect(sync.approval).toMatch(/sync_execute|approval/)
    expect(sync.error).toBeUndefined()
    const fetch = await evaluate(ev, makeStep("fetch_url", { url: "https://example.com" }), hostedCtx())
    expect(fetch.approval).toMatch(/outbound|approval/i)
    expect(fetch.error).toBeUndefined()
  })

  it("admins are not affected by hosted_user-scoped defaults", async () => {
    // No admin-targeted defaults exist; in hosted runMode an admin-only
    // session would still hit hosted_default_deny unless admins are
    // granted via DB-stored rules. Document that.
    const ev = buildHostedEvaluator()
    const adminCtx = hostedCtx({ role: "admin" })
    const result = await evaluate(ev, makeStep("read_file", { path: "/tmp/sb/x" }), adminCtx)
    expect(result.error?.message).toMatch(/hosted_default_deny/)
  })
})
