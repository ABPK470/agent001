/**
 * Factory policy defaults — loaded from deploy/policies/defaults.json.
 *
 * Validates the curated rule set behaves as designed when seeded into the
 * agent's selector policy engine. Mirrors the deployment seeding path
 * (orchestrator loads rules into `services.policyEvaluator` for hosted runs).
 */

import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  PolicyViolationError,
  RulePolicyEvaluator,
  type AgentRun,
  type HostedPolicyContext,
  type Step,
} from "@mia/agent"
import { describe, expect, it } from "vitest"

import { loadPolicyDefaults } from "../src/api/policies/service/load-policy-defaults.js"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

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

function hostedCtx(over: Partial<HostedPolicyContext> = {}): HostedPolicyContext {
  return {
    runId: "r1",
    runMode: "hosted",
    role: "hosted_user",
    sandboxRoot: "/tmp/sb",
    ...over,
  }
}

function buildHostedEvaluator(): RulePolicyEvaluator {
  const ev = new RulePolicyEvaluator()
  for (const rule of loadPolicyDefaults(REPO_ROOT).rules) ev.addRule(rule)
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

describe("deploy/policies/defaults.json", () => {
  it("loads a non-empty validated factory set", () => {
    const { version, rules } = loadPolicyDefaults(REPO_ROOT)
    expect(version).toBe(1)
    expect(rules.length).toBeGreaterThan(10)
    expect(rules.map((r) => r.name)).toContain("hosted_require_approval_sync_execute_prod")
  })

  it("allows reads/writes inside the sandbox", async () => {
    const ev = buildHostedEvaluator()
    const read = await evaluate(ev, makeStep("read_file", { path: "/tmp/sb/notes.txt" }), hostedCtx())
    expect(read.error).toBeUndefined()
    const write = await evaluate(
      ev,
      makeStep("write_file", { path: "/tmp/sb/out.csv", content: "x" }),
      hostedCtx(),
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
      hostedCtx(),
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

  it("allows MSSQL read tools including inspect_definition", async () => {
    const ev = buildHostedEvaluator()
    for (const action of [
      "query_mssql",
      "explore_mssql_schema",
      "inspect_definition",
      "profile_data",
      "discover_relationships",
      "export_query_to_file",
    ] as const) {
      const result = await evaluate(
        ev,
        makeStep(action, {
          connection: "prod",
          ...(action === "query_mssql" || action === "export_query_to_file"
            ? { query: "SELECT TOP 5 * FROM publish.Revenue" }
            : action === "inspect_definition"
              ? { depends_on: "publish.Revenue" }
              : {}),
        }),
        hostedCtx(),
      )
      expect(result.error, action).toBeUndefined()
    }
  })

  it("allows MSSQL reads on UAT and PROD but blocks UAT/PROD DML", async () => {
    const ev = buildHostedEvaluator()
    const uatRead = await evaluate(
      ev,
      makeStep("mssql_query", { environment: "uat", sql: "SELECT 1" }),
      hostedCtx(),
    )
    const prodRead = await evaluate(
      ev,
      makeStep("mssql_query", { environment: "prod", sql: "SELECT 1" }),
      hostedCtx(),
    )
    expect(uatRead.error).toBeUndefined()
    expect(prodRead.error).toBeUndefined()

    const uatDml = await evaluate(
      ev,
      makeStep("mssql_query", { environment: "uat", sql: "UPDATE t SET x=1" }),
      hostedCtx(),
    )
    const prodDml = await evaluate(
      ev,
      makeStep("mssql_query", { environment: "prod", sql: "INSERT INTO t VALUES (1)" }),
      hostedCtx(),
    )
    expect(uatDml.error?.message).toMatch(/UAT/)
    expect(prodDml.error?.message).toMatch(/PROD/)
  })

  it("allows DEV DML through default-deny for operator override (no explicit rule for DEV DML)", async () => {
    const ev = buildHostedEvaluator()
    const devDml = await evaluate(
      ev,
      makeStep("mssql_query", { environment: "dev", sql: "UPDATE t SET x=1" }),
      hostedCtx(),
    )
    expect(devDml.error?.message).toMatch(/hosted_default_deny/)
  })

  it("every visitor tool is allow or require_approval — never silent hosted_default_deny", async () => {
    const { listVisitorToolNames } = await import("../src/runtime/tooling/registry.js")
    const ev = buildHostedEvaluator()
    const sandboxPath = "sandbox://work/a.txt"
    const samples: Record<string, Record<string, unknown>> = {
      read_file: { path: sandboxPath },
      write_file: { path: sandboxPath, content: "x" },
      append_file: { path: sandboxPath, content: "x" },
      replace_in_file: { path: sandboxPath, old_string: "a", new_string: "b" },
      list_directory: { path: "sandbox://" },
      search_files: { pattern: "foo" },
      think: {},
      note: { subject: "x", body: "y" },
      record_table_verdict: { table: "core.T", role: "fact" },
      fetch_url: { url: "https://example.com" },
      ask_user: { prompt: "ok?" },
      search_catalog: { q: "x" },
      query_mssql: { connection: "dev", query: "SELECT 1" },
      explore_mssql_schema: { connection: "dev" },
      export_query_to_file: { connection: "dev", query: "SELECT 1" },
      discover_relationships: { connection: "dev" },
      profile_data: { connection: "dev", table: "core.T" },
      inspect_definition: { connection: "dev", depends_on: "core.T" },
      list_environments: {},
      list_sync_definitions: {},
      resolve_sync_scope: { q: "contract" },
      search_sync_entities: { entityType: "contract", source: "uat", q: "x" },
      sync_preview: { entityType: "contract", entityId: 1, source: "uat", target: "dev" },
      sync_execute: { planId: "p1", target: "dev", confirm: true },
      compare_catalogs: { source: "uat", target: "dev" },
      sync_diff_scan: { source: "uat", target: "dev", entityType: "contract" },
      list_attachments: {},
      read_attachment: { id: "a1" },
      import_attachment: { id: "a1" },
      promote_attachment: { id: "a1" },
    }

    const missingSample: string[] = []
    const denied: string[] = []
    for (const tool of listVisitorToolNames()) {
      const input = samples[tool]
      if (!input) {
        missingSample.push(tool)
        continue
      }
      const result = await evaluate(ev, makeStep(tool, input), hostedCtx())
      if (result.error?.message?.includes("hosted_default_deny")) {
        denied.push(tool)
      }
    }
    expect(missingSample, "add a benign sample input for each visitor tool").toEqual([])
    expect(denied, "visitor tools must be covered by factory allow/require_approval").toEqual([])
  })

  it("allows sync discovery tools needed for UAT→DEV chat sync", async () => {
    const ev = buildHostedEvaluator()
    for (const action of [
      "list_environments",
      "list_sync_definitions",
      "resolve_sync_scope",
      "search_sync_entities",
      "compare_catalogs",
      "sync_diff_scan",
      "sync_preview",
    ] as const) {
      const result = await evaluate(ev, makeStep(action, { source: "uat", target: "dev" }), hostedCtx())
      expect(result.error, action).toBeUndefined()
    }

    const execute = await evaluate(
      ev,
      makeStep("sync_execute", { planId: "p1", target: "dev", confirm: true }),
      hostedCtx(),
    )
    expect(execute.error).toBeUndefined()
  })

  it("allows sync_publish and sync_preview by default", async () => {
    const ev = buildHostedEvaluator()
    expect(loadPolicyDefaults(REPO_ROOT).rules.map((r) => r.name)).toContain("hosted_allow_sync_publish")

    const publish = await evaluate(
      ev,
      makeStep("sync_publish", { action: "publish_definitions" }),
      hostedCtx({ role: "admin" }),
    )
    expect(publish.error).toBeUndefined()
    expect(publish.approval).toBeNull()

    const preview = await evaluate(
      ev,
      makeStep("sync_preview", { source: "dev", target: "dev" }),
      hostedCtx(),
    )
    expect(preview.error).toBeUndefined()
    expect(preview.approval).toBeNull()
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

  it("allows agent sync_execute (planId+confirm only) when plan target resolves to DEV", async () => {
    const ev = buildHostedEvaluator()
    const missingTarget = await evaluate(
      ev,
      makeStep("sync_execute", { planId: "p1", confirm: true }),
      hostedCtx(),
    )
    expect(missingTarget.error?.message).toMatch(/hosted_default_deny/)

    const fromPlan = await evaluate(
      ev,
      makeStep("sync_execute", { planId: "p1", confirm: true }),
      hostedCtx({ resolveSyncPlanTarget: () => "dev" }),
    )
    expect(fromPlan.error).toBeUndefined()
    expect(fromPlan.approval).toBeNull()
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
