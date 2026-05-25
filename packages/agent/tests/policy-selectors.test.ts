/**
 * Selector-based policy engine tests.
 *
 * Covers the new selector matcher, hosted default-deny, priority/tie-break
 * resolution, fact extraction for files/shell/MSSQL, and back-compat with
 * the legacy `action:<name>` rules.
 */

import { describe, expect, it } from "vitest"
import {
    PolicyEffect,
    PolicyViolationError,
    RulePolicyEvaluator,
    type AgentRun,
    type HostedPolicyContext,
    type PolicyRule,
    type Step
} from "../src/domain/index.js"

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

async function evaluate(
  evaluator: RulePolicyEvaluator,
  step: Step,
  ctx?: HostedPolicyContext,
): Promise<{ approval: string | null; error?: PolicyViolationError }> {
  const run = { id: "r1" } as AgentRun
  try {
    const approval = await evaluator.evaluatePreStep(run, step, ctx ?? null)
    return { approval }
  } catch (err) {
    if (err instanceof PolicyViolationError) return { approval: null, error: err }
    throw err
  }
}

describe("selector policy engine", () => {
  it("preserves legacy action:<name> deny", async () => {
    const ev = new RulePolicyEvaluator()
    ev.addRule({
      name:       "no_echo",
      effect:     PolicyEffect.Deny,
      condition:  "action:echo",
      parameters: {},
    })
    const result = await evaluate(ev, makeStep("echo"))
    expect(result.error).toBeInstanceOf(PolicyViolationError)
  })

  it("allows legacy unrelated tools without context", async () => {
    const ev = new RulePolicyEvaluator()
    ev.addRule({
      name:       "no_echo",
      effect:     PolicyEffect.Deny,
      condition:  "action:echo",
      parameters: {},
    })
    const result = await evaluate(ev, makeStep("write_file", { path: "x.txt" }))
    expect(result.approval).toBeNull()
    expect(result.error).toBeUndefined()
  })

  it("hosted mode default-denies when no rule matches", async () => {
    const ev = new RulePolicyEvaluator()
    const result = await evaluate(ev, makeStep("read_file", { path: "x" }), hostedCtx())
    expect(result.error?.message).toMatch(/hosted_default_deny|no policy rule allows/)
  })

  it("developer mode allows when no rule matches", async () => {
    const ev = new RulePolicyEvaluator()
    const ctx = hostedCtx({ runMode: "developer", role: "admin" })
    const result = await evaluate(ev, makeStep("read_file", { path: "x" }), ctx)
    expect(result.approval).toBeNull()
    expect(result.error).toBeUndefined()
  })

  it("matches a hosted_user write inside sandbox via path scope", async () => {
    const ev = new RulePolicyEvaluator()
    ev.addRule({
      name:       "allow_sandbox_writes",
      effect:     PolicyEffect.Allow,
      condition:  "selectors",
      parameters: { selectors: { role: "hosted_user", tool: "write_file", scope: "sandbox" } },
    })
    const result = await evaluate(
      ev,
      makeStep("write_file", { path: "/tmp/sb/notes/out.txt", content: "x" }),
      hostedCtx(),
    )
    expect(result.approval).toBeNull()
    expect(result.error).toBeUndefined()
  })

  it("denies workspace reads for hosted_user via scope selector", async () => {
    const ev = new RulePolicyEvaluator()
    ev.addRule({
      name:       "no_workspace_reads",
      effect:     PolicyEffect.Deny,
      condition:  "selectors",
      parameters: { selectors: { role: "hosted_user", tool: "read_file", scope: "app_workspace" } },
    })
    const result = await evaluate(
      ev,
      makeStep("read_file", { path: "/etc/passwd" }),
      hostedCtx(),
    )
    expect(result.error).toBeInstanceOf(PolicyViolationError)
  })

  it("denies privileged shell tokens via command regex", async () => {
    const ev = new RulePolicyEvaluator()
    ev.addRule({
      name:       "no_privileged_cmds",
      effect:     PolicyEffect.Deny,
      condition:  "selectors",
      parameters: {
        selectors: { role: "hosted_user", tool: "run_command", command: "/\\b(sudo|ssh|git)\\b/i" },
        reason:    "blocked by hosted command allowlist",
      },
    })
    ev.addRule({
      name:       "allow_other_cmds",
      effect:     PolicyEffect.Allow,
      condition:  "selectors",
      parameters: { selectors: { role: "hosted_user", tool: "run_command" } },
    })
    const denied = await evaluate(ev, makeStep("run_command", { command: "sudo rm -rf /" }), hostedCtx())
    expect(denied.error?.message).toContain("hosted command allowlist")

    const ok = await evaluate(ev, makeStep("run_command", { command: "ls -la" }), hostedCtx())
    expect(ok.approval).toBeNull()
    expect(ok.error).toBeUndefined()
  })

  it("blocks DML on UAT/PROD by default and allows reads", async () => {
    const ev = new RulePolicyEvaluator()
    ev.addRule({
      name:       "block_uat_dml",
      effect:     PolicyEffect.Deny,
      condition:  "selectors",
      parameters: { selectors: { tool: "mssql_*", dbEnvironment: "uat", dbOperation: "dml" } },
    })
    ev.addRule({
      name:       "block_prod_dml",
      effect:     PolicyEffect.Deny,
      condition:  "selectors",
      parameters: { selectors: { tool: "mssql_*", dbEnvironment: "prod", dbOperation: "dml" } },
    })
    ev.addRule({
      name:       "allow_reads_anywhere",
      effect:     PolicyEffect.Allow,
      condition:  "selectors",
      parameters: { selectors: { tool: "mssql_*", dbOperation: "query_read" } },
    })

    const dml = await evaluate(
      ev,
      makeStep("mssql_query", { environment: "uat", sql: "UPDATE users SET x=1" }),
      hostedCtx(),
    )
    expect(dml.error?.message).toContain("uat")

    const read = await evaluate(
      ev,
      makeStep("mssql_query", { environment: "prod", sql: "SELECT 1" }),
      hostedCtx(),
    )
    expect(read.approval).toBeNull()
    expect(read.error).toBeUndefined()
  })

  it("classifies unknown SQL as DML so it cannot bypass UAT/PROD policy", async () => {
    const ev = new RulePolicyEvaluator()
    ev.addRule({
      name:       "block_uat_dml",
      effect:     PolicyEffect.Deny,
      condition:  "selectors",
      parameters: { selectors: { tool: "mssql_*", dbEnvironment: "uat", dbOperation: "dml" } },
    })
    ev.addRule({
      name:       "allow_uat_reads",
      effect:     PolicyEffect.Allow,
      condition:  "selectors",
      parameters: { selectors: { tool: "mssql_*", dbEnvironment: "uat", dbOperation: "query_read" } },
    })
    // SQL doesn't begin with SELECT/WITH/EXEC sp_help → conservative
    // fallback classifies as DML → blocked.
    const result = await evaluate(
      ev,
      makeStep("mssql_query", { environment: "uat", sql: "EXEC sp_someCustomProc @x = 1" }),
      hostedCtx(),
    )
    expect(result.error?.message).toMatch(/uat|block_uat_dml/)
  })

  it("priority and tie-breaker: deny wins over allow at equal priority", async () => {
    const ev = new RulePolicyEvaluator()
    ev.addRule({
      name:       "allow_sandbox_writes",
      effect:     PolicyEffect.Allow,
      condition:  "selectors",
      parameters: { priority: 10, selectors: { role: "hosted_user", tool: "write_file", scope: "sandbox" } },
    })
    ev.addRule({
      name:       "deny_secret_paths",
      effect:     PolicyEffect.Deny,
      condition:  "selectors",
      parameters: { priority: 10, selectors: { role: "hosted_user", tool: "write_file", path: "sandbox://secrets/**" } },
    })
    const result = await evaluate(
      ev,
      makeStep("write_file", { path: "sandbox://secrets/key.pem", content: "x" }),
      hostedCtx(),
    )
    expect(result.error?.message).toMatch(/deny_secret_paths|secrets/)
  })

  it("higher priority wins regardless of effect rank", async () => {
    const ev = new RulePolicyEvaluator()
    ev.addRule({
      name:       "global_deny",
      effect:     PolicyEffect.Deny,
      condition:  "selectors",
      parameters: { priority: 1, selectors: { role: "hosted_user", tool: "write_file" } },
    })
    ev.addRule({
      name:       "explicit_sandbox_allow",
      effect:     PolicyEffect.Allow,
      condition:  "selectors",
      parameters: { priority: 100, selectors: { role: "hosted_user", tool: "write_file", scope: "sandbox" } },
    })
    const result = await evaluate(
      ev,
      makeStep("write_file", { path: "/tmp/sb/ok.txt", content: "x" }),
      hostedCtx(),
    )
    expect(result.approval).toBeNull()
    expect(result.error).toBeUndefined()
  })

  it("require_approval surfaces the rule reason", async () => {
    const ev = new RulePolicyEvaluator()
    ev.addRule({
      name:       "approve_fetch",
      effect:     PolicyEffect.RequireApproval,
      condition:  "selectors",
      parameters: { selectors: { role: "hosted_user", tool: "fetch_url" }, reason: "outbound network needs approval" },
    })
    const result = await evaluate(
      ev,
      makeStep("fetch_url", { url: "https://example.com" }),
      hostedCtx(),
    )
    expect(result.approval).toContain("outbound network needs approval")
    expect(result.error).toBeUndefined()
  })

  it("inert (empty selectors) rule never matches", async () => {
    const ev = new RulePolicyEvaluator()
    const rule: PolicyRule = {
      name:       "broken",
      effect:     PolicyEffect.Deny,
      condition:  "selectors",
      parameters: {},
    }
    ev.addRule(rule)
    // No selectors → no match → hosted default-deny still kicks in.
    const result = await evaluate(ev, makeStep("noop"), hostedCtx())
    expect(result.error?.message).toMatch(/hosted_default_deny/)
  })
})

describe("explicit policy-context isolation", () => {
  it("concurrent runs see independent policy contexts", async () => {
    const ev = new RulePolicyEvaluator()
    ev.addRule({
      name:       "admin_all",
      effect:     PolicyEffect.Allow,
      condition:  "selectors",
      parameters: { selectors: { role: "admin", tool: "*" } },
    })

    const adminCtx = hostedCtx({ role: "admin" })
    const userCtx  = hostedCtx({ role: "hosted_user" })

    const [adminResult, userResult] = await Promise.all([
      evaluate(ev, makeStep("anything"), adminCtx),
      evaluate(ev, makeStep("anything"), userCtx),
    ])

    expect(adminResult.error).toBeUndefined()
    expect(userResult.error?.message).toMatch(/hosted_default_deny/)
  })
})
