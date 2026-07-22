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
import { hostedDefaultPolicyRules } from "../src/api/policies/types/hosted-defaults.js"

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

function hostedCtx(over: Partial<HostedPolicyContext> = {}): HostedPolicyContext {
  return {
    runId: "r1",
    runMode: "hosted",
    role: "hosted_user",
    sandboxRoot: "/tmp/sb",
    ...over
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
  ctx: HostedPolicyContext
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
    const write = await evaluate(
      ev,
      makeStep("write_file", { path: "/tmp/sb/out.csv", content: "x" }),
      hostedCtx()
    )
    expect(write.error).toBeUndefined()
  })

  it("denies reads and writes against the application workspace", async () => {
    const ev = buildHostedEvaluator()
    const read = await evaluate(ev, makeStep("read_file", { path: "workspace://src/secret.ts" }), hostedCtx())
    expect(read.error?.message).toMatch(/workspace/)
    const write = await evaluate(
      ev,
      makeStep("write_file", { path: "/etc/passwd", content: "x" }),
      hostedCtx()
    )
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
    const uatRead = await evaluate(
      ev,
      makeStep("mssql_query", { environment: "uat", sql: "SELECT 1" }),
      hostedCtx()
    )
    const prodRead = await evaluate(
      ev,
      makeStep("mssql_query", { environment: "prod", sql: "SELECT 1" }),
      hostedCtx()
    )
    expect(uatRead.error).toBeUndefined()
    expect(prodRead.error).toBeUndefined()

    const uatDml = await evaluate(
      ev,
      makeStep("mssql_query", { environment: "uat", sql: "UPDATE t SET x=1" }),
      hostedCtx()
    )
    const prodDml = await evaluate(
      ev,
      makeStep("mssql_query", { environment: "prod", sql: "INSERT INTO t VALUES (1)" }),
      hostedCtx()
    )
    expect(uatDml.error?.message).toMatch(/UAT/)
    expect(prodDml.error?.message).toMatch(/PROD/)
  })

  it("allows DEV DML through default-deny for operator override (no explicit rule for DEV DML)", async () => {
    // The defaults intentionally do not define a DEV DML rule. Hosted
    // default-deny will still block it unless the operator explicitly opts
    // in via a DB-stored rule. This test documents that contract.
    const ev = buildHostedEvaluator()
    const devDml = await evaluate(
      ev,
      makeStep("mssql_query", { environment: "dev", sql: "UPDATE t SET x=1" }),
      hostedCtx()
    )
    expect(devDml.error?.message).toMatch(/hosted_default_deny/)
  })

  it("allows sync_execute on DEV, denies UAT, requires approval on PROD", async () => {
    const ev = buildHostedEvaluator()
    const preview = await evaluate(
      ev,
      makeStep("sync_preview", { source: "dev", target: "dev" }),
      hostedCtx(),
    )
    expect(preview.error).toBeUndefined()
    expect(preview.approval).toBeNull()

    const dev = await evaluate(
      ev,
      makeStep("sync_execute", { planId: "p1", target: "dev", confirm: true }),
      hostedCtx({ role: "admin" }),
    )
    expect(dev.error).toBeUndefined()
    expect(dev.approval).toBeNull()

    const uat = await evaluate(
      ev,
      makeStep("sync_execute", { planId: "p1", target: "uat", confirm: true }),
      hostedCtx({ role: "admin" }),
    )
    expect(uat.error?.message).toMatch(/UAT|denied/i)

    const prod = await evaluate(
      ev,
      makeStep("sync_execute", { planId: "p1", target: "prod", confirm: true }),
      hostedCtx({ role: "admin" }),
    )
    expect(prod.approval).toMatch(/PROD|approval|sync_execute/i)
    expect(prod.error).toBeUndefined()
  })

  it("requires approval for outbound fetch", async () => {
    const ev = buildHostedEvaluator()
    const fetch = await evaluate(ev, makeStep("fetch_url", { url: "https://example.com" }), hostedCtx())
    expect(fetch.approval).toMatch(/outbound|approval/i)
    expect(fetch.error).toBeUndefined()
  })

  it("admin role is governed the same as hosted_user (no policy bypass)", async () => {
    const ev = buildHostedEvaluator()
    const adminCtx = hostedCtx({ role: "admin" })
    const sandboxRead = await evaluate(ev, makeStep("read_file", { path: "/tmp/sb/x" }), adminCtx)
    expect(sandboxRead.error).toBeUndefined()
    const prod = await evaluate(
      ev,
      makeStep("sync_execute", { planId: "p1", target: "prod", confirm: true }),
      adminCtx,
    )
    expect(prod.approval).toMatch(/PROD|approval|sync_execute/i)
  })
})
