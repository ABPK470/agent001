/**
 * Seed one demo thread with 3 runs of increasing Trace complexity.
 *
 * Usage (from packages/server):
 *   npx tsx src/cli/seed-demo-trace-thread.ts
 *   npx tsx src/cli/seed-demo-trace-thread.ts --upn pka
 *
 * Writes to ~/.mia/mia.db (or $MIA_DATA_DIR/mia.db).
 */

import "../boot/load-env.js"
import { randomUUID } from "node:crypto"
import type { TraceEntry } from "@mia/shared-types"
import {
  createThread,
  getDbPath,
  listUsers,
  openDatabase,
  saveRun,
  saveTraceEntry,
  touchThread,
} from "../infra/persistence/db/index.js"

const args = process.argv.slice(2)
const upnArg = args.find((a) => a.startsWith("--upn="))?.slice(6)
  ?? (args.includes("--upn") ? args[args.indexOf("--upn") + 1] : undefined)

openDatabase()

const users = listUsers()
const upn = (upnArg ?? users[0]?.upn ?? "").toLowerCase()
if (!upn) {
  console.error("No users in the database. Log in once, then re-run this script.")
  process.exit(1)
}

const now = Date.now()
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString()

function msg(
  role: string,
  content: string | null,
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [],
  toolCallId: string | null = null,
) {
  return { role, content, toolCalls, toolCallId }
}

function llmReq(
  iteration: number,
  messages: ReturnType<typeof msg>[],
  toolCount = 0,
): TraceEntry {
  return {
    kind: "llm-request",
    iteration,
    messageCount: messages.length,
    toolCount,
    messages,
  }
}

/** Prefixed with the run system prompt — matches what the model actually receives. */
function withSystem(system: string, messages: ReturnType<typeof msg>[]): ReturnType<typeof msg>[] {
  return [msg("system", system), ...messages]
}

function llmRes(
  iteration: number,
  opts: {
    content?: string | null
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
    durationMs?: number
    prompt?: number
    completion?: number
  } = {},
): TraceEntry {
  const prompt = opts.prompt ?? 120 + iteration * 40
  const completion = opts.completion ?? 48 + iteration * 10
  return {
    kind: "llm-response",
    iteration,
    durationMs: opts.durationMs ?? 180 + iteration * 40,
    content: opts.content ?? null,
    toolCalls: opts.toolCalls ?? [],
    usage: {
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: prompt + completion,
    },
  }
}

function emptySqlQuality(
  overrides: Partial<Extract<TraceEntry, { kind: "planner-sql-quality" }>> & {
    toolCallId: string
    toolName: string
    iteration: number
  },
): TraceEntry {
  return {
    kind: "planner-sql-quality",
    toolMode: "query",
    phase: "executed",
    connection: "main",
    database: "DemoDb",
    validationOk: true,
    validationCode: null,
    largeObjectRefs: [],
    usesPersistedMirrors: [],
    missingPersistedMirrorCandidates: [],
    hasWhereClause: true,
    unsafeScanReason: null,
    tempTableRefs: 0,
    tempTablesCreated: 0,
    tempTableSuffixes: [],
    malformedTempSuffixes: [],
    missingTempCreations: [],
    aggregateWarningCount: 0,
    aggregateBlockCount: 0,
    tempScalarSubqueryCount: 0,
    stagePatternLikely: false,
    durationMs: 12,
    rowCount: 3,
    error: null,
    sqlPreview: "SELECT 1 AS n",
    sqlLength: 14,
    ...overrides,
  }
}

function budget(extra?: Partial<{
  hint: string
  parsedHint: number
  baseBudget: number
  contractFloor: number
  complexityBoost: number
  computedMaxIterations: number
  targetArtifactCount: number
  requiredSourceArtifactCount: number
  acceptanceCriteriaCount: number
  codeArtifactCount: number
  hasComplexImplementation: boolean
  hasBlueprintSource: boolean
}>) {
  return {
    hint: "standard",
    parsedHint: 12,
    baseBudget: 12,
    contractFloor: 8,
    complexityBoost: 2,
    computedMaxIterations: 14,
    targetArtifactCount: 2,
    requiredSourceArtifactCount: 1,
    acceptanceCriteriaCount: 3,
    codeArtifactCount: 1,
    hasComplexImplementation: true,
    hasBlueprintSource: false,
    verificationMode: "run_tests" as const,
    ...extra,
  }
}

/** Run 1 — Direct route, 4 LLM round-trips with tool work between. */
function buildDirectFourCalls(): TraceEntry[] {
  const goal = "List top bankers and export a small CSV summary"
  const system = "You are Mia. Prefer query_mssql for data questions."
  const tools = [
    { name: "query_mssql", description: "Run SQL", parameters: { type: "object" } },
    { name: "export_query_to_file", description: "Export query to file", parameters: { type: "object" } },
    { name: "list_directory", description: "List files", parameters: { type: "object" } },
  ]

  const u0 = withSystem(system, [msg("user", goal)])
  const tcExplore = { id: "d-tc-explore", name: "list_directory", arguments: { path: "." } }
  const u1 = withSystem(system, [
    msg("user", goal),
    msg("assistant", null, [tcExplore]),
    msg("tool", "README.md\nsrc/\ndata/", [], "d-tc-explore"),
  ])
  const tcSql = {
    id: "d-tc-sql",
    name: "query_mssql",
    arguments: { sql: "SELECT TOP 5 name, revenue FROM bankers ORDER BY revenue DESC" },
  }
  const u2 = withSystem(system, [
    msg("user", goal),
    msg("assistant", null, [tcExplore]),
    msg("tool", "README.md\nsrc/\ndata/", [], "d-tc-explore"),
    msg("assistant", null, [tcSql]),
    msg("tool", "name | revenue\nAda | 120\nBea | 95", [], "d-tc-sql"),
  ])
  const tcExport = {
    id: "d-tc-export",
    name: "export_query_to_file",
    arguments: { sql: "SELECT TOP 5 name, revenue FROM bankers ORDER BY revenue DESC", path: "top-bankers.csv" },
  }
  const u3 = withSystem(system, [
    msg("user", goal),
    msg("assistant", null, [tcExplore]),
    msg("tool", "README.md\nsrc/\ndata/", [], "d-tc-explore"),
    msg("assistant", null, [tcSql]),
    msg("tool", "name | revenue\nAda | 120\nBea | 95", [], "d-tc-sql"),
    msg("assistant", null, [tcExport]),
    msg("tool", "Wrote top-bankers.csv (5 rows)", [], "d-tc-export"),
  ])

  return [
    { kind: "goal", text: goal },
    { kind: "system-prompt", text: system },
    { kind: "tools-resolved", tools },
    {
      kind: "planner-decision",
      score: 2,
      shouldPlan: false,
      route: "direct",
      reason: "domain_data_query",
    },
    { kind: "iteration", current: 1, max: 12 },
    llmReq(0, u0, 3),
    llmRes(0, { toolCalls: [tcExplore], durationMs: 210, prompt: 90, completion: 30 }),
    {
      kind: "tool-call",
      invocationId: "d-inv-explore",
      toolCallId: "d-tc-explore",
      tool: "list_directory",
      argsSummary: 'path="."',
      argsFormatted: JSON.stringify(tcExplore.arguments),
    },
    { kind: "tool-result", invocationId: "d-inv-explore", toolCallId: "d-tc-explore", text: "README.md\nsrc/\ndata/" },
    { kind: "iteration", current: 2, max: 12 },
    llmReq(1, u1, 3),
    llmRes(1, { toolCalls: [tcSql], durationMs: 340, prompt: 140, completion: 55 }),
    {
      kind: "tool-call",
      invocationId: "d-inv-sql",
      toolCallId: "d-tc-sql",
      tool: "query_mssql",
      argsSummary: "SELECT TOP 5…",
      argsFormatted: JSON.stringify(tcSql.arguments),
    },
    emptySqlQuality({
      toolCallId: "d-tc-sql",
      toolName: "query_mssql",
      iteration: 1,
      sqlPreview: String(tcSql.arguments.sql),
      sqlLength: String(tcSql.arguments.sql).length,
      rowCount: 5,
    }),
    {
      kind: "tool-result",
      invocationId: "d-inv-sql",
      toolCallId: "d-tc-sql",
      text: "name | revenue\nAda | 120\nBea | 95\nCal | 88\nDee | 70\nEve | 61",
    },
    { kind: "iteration", current: 3, max: 12 },
    llmReq(2, u2, 3),
    llmRes(2, { toolCalls: [tcExport], durationMs: 280, prompt: 200, completion: 40 }),
    {
      kind: "tool-call",
      invocationId: "d-inv-export",
      toolCallId: "d-tc-export",
      tool: "export_query_to_file",
      argsSummary: "top-bankers.csv",
      argsFormatted: JSON.stringify(tcExport.arguments),
    },
    {
      kind: "tool-result",
      invocationId: "d-inv-export",
      toolCallId: "d-tc-export",
      text: "Wrote top-bankers.csv (5 rows)",
    },
    { kind: "iteration", current: 4, max: 12 },
    llmReq(3, u3, 3),
    llmRes(3, {
      content:
        "Here are the top 5 bankers by revenue. I also exported them to `top-bankers.csv`.\n\n| Name | Revenue |\n| --- | ---: |\n| Ada | 120 |\n| Bea | 95 |\n| Cal | 88 |\n| Dee | 70 |\n| Eve | 61 |",
      durationMs: 420,
      prompt: 260,
      completion: 110,
    }),
    {
      kind: "usage",
      iterationTokens: 370,
      totalTokens: 1105,
      promptTokens: 690,
      completionTokens: 235,
      llmCalls: 4,
    },
    {
      kind: "answer",
      text: "Top 5 bankers exported to top-bankers.csv.",
    },
    {
      kind: "workspace_diff",
      diff: { added: ["top-bankers.csv"], modified: [], deleted: [] },
    },
    { kind: "workspace_diff_applied", summary: { added: 1, modified: 0, deleted: 0 } },
  ]
}

/** Run 2 — Planner route with pipeline + 5 LLM calls. */
function buildPlannerFiveCalls(): TraceEntry[] {
  const goal =
    "Build a small dashboard site with a landing page, metrics page, and export endpoint. Create the schema, API, then frontend."
  const system = "You are Mia. Use the planner for multi-step greenfield builds."
  const tools = [
    { name: "write_file", description: "Write a file", parameters: { type: "object" } },
    { name: "read_file", description: "Read a file", parameters: { type: "object" } },
    { name: "run_command", description: "Run a shell command", parameters: { type: "object" } },
    { name: "query_mssql", description: "Run SQL", parameters: { type: "object" } },
  ]

  const steps = [
    { name: "schema_contract", type: "subagent_task", dependsOn: [] as string[] },
    { name: "api_endpoints", type: "subagent_task", dependsOn: ["schema_contract"] },
    { name: "frontend_pages", type: "subagent_task", dependsOn: ["api_endpoints"] },
  ]

  const u0 = withSystem(system, [msg("user", goal)])
  const tcWriteSchema = {
    id: "p-tc-schema",
    name: "write_file",
    arguments: { path: "db/schema.sql", content: "CREATE TABLE metrics (...);" },
  }
  const u1 = [
    ...u0,
    msg("assistant", "I'll start with the schema.", [tcWriteSchema]),
    msg("tool", "Wrote db/schema.sql", [], "p-tc-schema"),
  ]
  const tcApi = {
    id: "p-tc-api",
    name: "write_file",
    arguments: { path: "src/api/metrics.ts", content: "export function listMetrics() {}" },
  }
  const u2 = [
    ...u1,
    msg("assistant", null, [tcApi]),
    msg("tool", "Wrote src/api/metrics.ts", [], "p-tc-api"),
  ]
  const tcFront = {
    id: "p-tc-front",
    name: "write_file",
    arguments: { path: "web/index.html", content: "<html>…</html>" },
  }
  const u3 = [
    ...u2,
    msg("assistant", null, [tcFront]),
    msg("tool", "Wrote web/index.html", [], "p-tc-front"),
  ]
  const tcTest = {
    id: "p-tc-test",
    name: "run_command",
    arguments: { command: "npm test -- --run" },
  }
  const u4 = [
    ...u3,
    msg("assistant", null, [tcTest]),
    msg("tool", "Tests: 3 passed", [], "p-tc-test"),
  ]

  return [
    { kind: "goal", text: goal },
    { kind: "system-prompt", text: system },
    { kind: "tools-resolved", tools },
    { kind: "tools-filtered", dropped: ["delegate_parallel"], kept: 4, dbScore: 0.2, syncTrigger: false, reason: "low utility" },
    { kind: "planning_preflight", mode: "planner-first" },
    {
      kind: "planner-decision",
      score: 9,
      shouldPlan: true,
      route: "planner",
      reason: "multi_step+implementation_scope",
    },
    { kind: "planner-generating" },
    {
      kind: "planner-plan-generated",
      reason: "greenfield dashboard",
      stepCount: 3,
      steps,
      edges: [
        { from: "schema_contract", to: "api_endpoints" },
        { from: "api_endpoints", to: "frontend_pages" },
      ],
    },
    {
      kind: "planner-runtime-compiled",
      executionSteps: steps.map((s) => ({
        stepName: s.name,
        dependsOn: s.dependsOn,
        downstream: steps.filter((x) => x.dependsOn.includes(s.name)).map((x) => x.name),
      })),
      ownershipArtifacts: [
        { artifactPath: "db/schema.sql", ownerStepName: "schema_contract", consumerStepNames: ["api_endpoints"] },
        { artifactPath: "web/index.html", ownerStepName: "frontend_pages", consumerStepNames: [] },
      ],
      runtimeEntities: [
        { id: "ent-schema", entityType: "step", stepName: "schema_contract" },
        { id: "ent-api", entityType: "step", stepName: "api_endpoints", parentId: "ent-schema" },
      ],
    },
    { kind: "planner-pipeline-start", attempt: 1, maxRetries: 2 },
    { kind: "planner-step-start", stepName: "schema_contract", stepType: "subagent_task" },
    {
      kind: "planner-delegation-start",
      goal: "Create SQL schema for metrics",
      stepName: "schema_contract",
      depth: 1,
      tools: ["write_file", "read_file", "run_command"],
      budget: budget({ computedMaxIterations: 10, codeArtifactCount: 1 }),
      envelope: {
        workspaceRoot: "/tmp/mia-demo",
        effectClass: "filesystem_write",
        verificationMode: "run_tests",
        targetArtifacts: ["db/schema.sql"],
      },
    },
    {
      kind: "planner-delegation-iteration",
      stepName: "schema_contract",
      depth: 1,
      iteration: 1,
      maxIterations: 10,
      toolNames: ["write_file"],
      content: "Drafting schema…",
    },
    { kind: "iteration", current: 1, max: 16 },
    llmReq(0, u0, 4),
    llmRes(0, { toolCalls: [tcWriteSchema], content: "I'll start with the schema." }),
    {
      kind: "tool-call",
      invocationId: "p-inv-schema",
      toolCallId: "p-tc-schema",
      tool: "write_file",
      argsSummary: "db/schema.sql",
      argsFormatted: JSON.stringify(tcWriteSchema.arguments),
    },
    { kind: "tool-result", invocationId: "p-inv-schema", toolCallId: "p-tc-schema", text: "Wrote db/schema.sql" },
    {
      kind: "planner-delegation-end",
      stepName: "schema_contract",
      depth: 1,
      status: "done",
      answer: "Schema ready",
    },
    {
      kind: "planner-step-end",
      stepName: "schema_contract",
      status: "pass",
      durationMs: 1200,
      producedArtifacts: ["db/schema.sql"],
    },
    { kind: "planner-step-start", stepName: "api_endpoints", stepType: "subagent_task" },
    {
      kind: "planner-delegation-start",
      goal: "Implement metrics API",
      stepName: "api_endpoints",
      depth: 1,
      tools: ["write_file", "read_file"],
      budget: budget(),
      envelope: { targetArtifacts: ["src/api/metrics.ts"], verificationMode: "run_tests" },
    },
    {
      kind: "planner-delegation-iteration",
      stepName: "api_endpoints",
      depth: 1,
      iteration: 1,
      maxIterations: 14,
      toolNames: ["write_file"],
    },
    { kind: "iteration", current: 2, max: 16 },
    llmReq(1, u1, 4),
    llmRes(1, { toolCalls: [tcApi] }),
    {
      kind: "tool-call",
      invocationId: "p-inv-api",
      toolCallId: "p-tc-api",
      tool: "write_file",
      argsSummary: "src/api/metrics.ts",
      argsFormatted: JSON.stringify(tcApi.arguments),
    },
    { kind: "tool-result", invocationId: "p-inv-api", toolCallId: "p-tc-api", text: "Wrote src/api/metrics.ts" },
    { kind: "planner-delegation-end", stepName: "api_endpoints", depth: 1, status: "done", answer: "API stubbed" },
    {
      kind: "planner-step-end",
      stepName: "api_endpoints",
      status: "pass",
      durationMs: 900,
      producedArtifacts: ["src/api/metrics.ts"],
    },
    { kind: "planner-step-start", stepName: "frontend_pages", stepType: "subagent_task" },
    {
      kind: "planner-delegation-start",
      goal: "Build landing + metrics pages",
      stepName: "frontend_pages",
      depth: 1,
      tools: ["write_file"],
      budget: budget({ hasComplexImplementation: true }),
      envelope: { targetArtifacts: ["web/index.html"] },
    },
    { kind: "iteration", current: 3, max: 16 },
    llmReq(2, u2, 4),
    llmRes(2, { toolCalls: [tcFront] }),
    {
      kind: "tool-call",
      invocationId: "p-inv-front",
      toolCallId: "p-tc-front",
      tool: "write_file",
      argsSummary: "web/index.html",
      argsFormatted: JSON.stringify(tcFront.arguments),
    },
    { kind: "tool-result", invocationId: "p-inv-front", toolCallId: "p-tc-front", text: "Wrote web/index.html" },
    {
      kind: "planner-delegation-iteration",
      stepName: "frontend_pages",
      depth: 1,
      iteration: 2,
      maxIterations: 14,
      toolNames: ["run_command"],
    },
    { kind: "iteration", current: 4, max: 16 },
    llmReq(3, u3, 4),
    llmRes(3, { toolCalls: [tcTest] }),
    {
      kind: "tool-call",
      invocationId: "p-inv-test",
      toolCallId: "p-tc-test",
      tool: "run_command",
      argsSummary: "npm test",
      argsFormatted: JSON.stringify(tcTest.arguments),
    },
    { kind: "tool-result", invocationId: "p-inv-test", toolCallId: "p-tc-test", text: "Tests: 3 passed" },
    { kind: "planner-delegation-end", stepName: "frontend_pages", depth: 1, status: "done", answer: "UI shipped" },
    {
      kind: "planner-step-end",
      stepName: "frontend_pages",
      status: "pass",
      durationMs: 1500,
      producedArtifacts: ["web/index.html"],
    },
    {
      kind: "planner-verification",
      overall: "pass",
      confidence: 0.86,
      verifierRound: 1,
      steps: [
        { stepName: "schema_contract", outcome: "pass", issues: [] },
        { stepName: "api_endpoints", outcome: "pass", issues: [] },
        { stepName: "frontend_pages", outcome: "pass", issues: [] },
      ],
    },
    {
      kind: "planner-pipeline-end",
      status: "success",
      completedSteps: 3,
      totalSteps: 3,
    },
    { kind: "iteration", current: 5, max: 16 },
    llmReq(4, u4, 4),
    llmRes(4, {
      content:
        "Dashboard build complete:\n\n1. Schema in `db/schema.sql`\n2. API stub in `src/api/metrics.ts`\n3. Landing page in `web/index.html`\n\nAll three planner steps passed verification.",
      prompt: 400,
      completion: 90,
    }),
    {
      kind: "usage",
      iterationTokens: 490,
      totalTokens: 2100,
      promptTokens: 1500,
      completionTokens: 600,
      llmCalls: 5,
    },
    { kind: "answer", text: "Dashboard schema, API, and frontend are in place." },
    {
      kind: "workspace_diff",
      diff: {
        added: ["db/schema.sql", "src/api/metrics.ts", "web/index.html"],
        modified: [],
        deleted: [],
      },
    },
    { kind: "workspace_diff_applied", summary: { added: 3, modified: 0, deleted: 0 } },
  ]
}

/** Run 3 — densest possible representative of every Trace family we track. */
function buildKitchenSink(): TraceEntry[] {
  const goal =
    "Create a website with landing, about, and contact form. First schema, then API, then frontend — verify and repair if needed."
  const system = "You are Mia with full planner + sync + delegation tooling."
  const tools = [
    { name: "write_file", description: "Write", parameters: { type: "object" } },
    { name: "read_file", description: "Read", parameters: { type: "object" } },
    { name: "run_command", description: "Shell", parameters: { type: "object" } },
    { name: "query_mssql", description: "SQL", parameters: { type: "object" } },
    { name: "sync_preview", description: "Preview sync", parameters: { type: "object" } },
    { name: "ask_user", description: "Ask the human", parameters: { type: "object" } },
    { name: "delegate", description: "Delegate", parameters: { type: "object" } },
  ]

  const base = withSystem(system, [msg("user", goal)])
  const tcAsk = { id: "k-tc-ask", name: "ask_user", arguments: { question: "Which brand colors?" } }
  const afterAsk = [
    ...base,
    msg("assistant", null, [tcAsk]),
    msg("tool", "Use navy and cream.", [], "k-tc-ask"),
  ]
  const tcSqlBad = {
    id: "k-tc-sql-bad",
    name: "query_mssql",
    arguments: { sql: "SELECT * FROM HugeTable" },
  }
  const afterSql = [
    ...afterAsk,
    msg("assistant", null, [tcSqlBad]),
    msg("tool", "Blocked: missing WHERE", [], "k-tc-sql-bad"),
  ]
  const tcSqlOk = {
    id: "k-tc-sql-ok",
    name: "query_mssql",
    arguments: { sql: "SELECT TOP 10 id, name FROM clients WHERE active = 1" },
  }
  const afterSqlOk = [
    ...afterSql,
    msg("assistant", null, [tcSqlOk]),
    msg("tool", "10 rows", [], "k-tc-sql-ok"),
  ]
  const tcSync = {
    id: "k-tc-sync",
    name: "sync_preview",
    arguments: {
      entityType: "client",
      entityId: 42,
      source: "dev",
      target: "uat",
    },
  }
  const afterSync = [
    ...afterSqlOk,
    msg("assistant", null, [tcSync]),
    msg("tool", "Preview OK — 2 tables", [], "k-tc-sync"),
  ]
  const tcWrite = {
    id: "k-tc-write",
    name: "write_file",
    arguments: { path: "site/contact.html", content: "<form>…</form>" },
  }
  const afterWrite = [
    ...afterSync,
    msg("assistant", null, [tcWrite]),
    msg("tool", "Wrote site/contact.html", [], "k-tc-write"),
  ]
  const tcBoom = {
    id: "k-tc-boom",
    name: "run_command",
    arguments: { command: "npm run build" },
  }
  const afterBoom = [
    ...afterWrite,
    msg("assistant", null, [tcBoom]),
    msg("tool", "Error: Module not found", [], "k-tc-boom"),
  ]
  const tcTokens = {
    id: "k-tc-tokens",
    name: "write_file",
    arguments: {
      path: "site/brand-tokens.js",
      content: "export const brand = { navy: '#0a1628', cream: '#f5f0e8' }",
    },
  }
  const afterTokens = [
    ...afterBoom,
    msg("assistant", null, [tcTokens]),
    msg("tool", "Wrote site/brand-tokens.js", [], "k-tc-tokens"),
  ]
  const tcRebuild = {
    id: "k-tc-rebuild",
    name: "run_command",
    arguments: { command: "npm run build" },
  }
  const afterRebuild = [
    ...afterTokens,
    msg("assistant", null, [tcRebuild]),
    msg("tool", "Build succeeded", [], "k-tc-rebuild"),
  ]

  return [
    { kind: "goal", text: goal },
    { kind: "system-prompt", text: system },
    { kind: "tools-resolved", tools },
    {
      kind: "tools-filtered",
      dropped: ["promote_attachment"],
      kept: 7,
      dbScore: 0.55,
      syncTrigger: true,
      reason: "sync intent detected",
    },
    { kind: "planning_preflight", mode: "planner-first" },
    {
      kind: "planner-decision",
      score: 11,
      shouldPlan: true,
      route: "planner",
      reason: "multi_step+implementation_scope+verification_on_impl",
    },
    { kind: "planner-generating" },
    {
      kind: "planner-generation-failed",
      diagnostics: [{ code: "PARSE_RETRY", message: "First draft invalid JSON — regenerating" }],
    },
    { kind: "planner-generating" },
    {
      kind: "planner-plan-generated",
      reason: "multi-page site",
      stepCount: 4,
      steps: [
        { name: "blueprint_site", type: "subagent_task" },
        { name: "schema_layer", type: "subagent_task", dependsOn: ["blueprint_site"] },
        { name: "api_layer", type: "subagent_task", dependsOn: ["schema_layer"] },
        { name: "frontend_layer", type: "subagent_task", dependsOn: ["api_layer"] },
      ],
    },
    {
      kind: "planner-validation-warnings",
      warningCount: 1,
      diagnostics: [{ code: "WEAK_ACCEPTANCE", message: "Acceptance criteria could be tighter" }],
    },
    {
      kind: "planner-validation-remediated",
      diagnostics: [{ code: "WEAK_ACCEPTANCE", message: "Tightened acceptance criteria" }],
    },
    {
      kind: "planner-output-root-forced",
      outputRoot: "/tmp/mia-kitchen-sink",
    },
    {
      kind: "planner-runtime-compiled",
      executionSteps: [
        { stepName: "blueprint_site", dependsOn: [], downstream: ["schema_layer"] },
        { stepName: "schema_layer", dependsOn: ["blueprint_site"], downstream: ["api_layer"] },
        { stepName: "api_layer", dependsOn: ["schema_layer"], downstream: ["frontend_layer"] },
        { stepName: "frontend_layer", dependsOn: ["api_layer"], downstream: [] },
      ],
      ownershipArtifacts: [
        { artifactPath: "site/contact.html", ownerStepName: "frontend_layer", consumerStepNames: [] },
      ],
      runtimeEntities: [{ id: "rt-1", entityType: "pipeline", stepName: "blueprint_site" }],
    },
    {
      kind: "planner-prompt-budget",
      iteration: 0,
      model: "gpt-demo",
      totalBeforeChars: 48000,
      totalAfterChars: 32000,
      totalChars: 32000,
      constrained: true,
      droppedSections: ["old_tool_noise"],
      sectionAfterChars: { system: 4000, history: 12000, tools: 8000 },
      sectionAfterMessages: { history: 12 },
      sectionTruncatedMessages: { history: 2 },
    },
    {
      kind: "planner-delegation-decision",
      shouldDelegate: true,
      reason: "parallelizable_work",
      utilityScore: 0.72,
      safetyRisk: 0.1,
      confidence: 0.8,
      hardBlockedTaskClass: null,
    },
    { kind: "planner-pipeline-start", attempt: 1, verifierRound: 0, maxRetries: 2 },
    { kind: "planner-step-start", stepName: "blueprint_site", stepType: "subagent_task" },
    {
      kind: "planner-step-transition",
      attempt: 1,
      stepName: "blueprint_site",
      phase: "execution",
      state: "running",
      timestamp: now,
    },
    {
      kind: "planner-delegation-start",
      goal: "Blueprint pages",
      stepName: "blueprint_site",
      depth: 1,
      tools: ["write_file", "read_file", "ask_user"],
      budget: budget({ hasBlueprintSource: true }),
      envelope: {
        workspaceRoot: "/tmp/mia-kitchen-sink",
        effectClass: "filesystem_write",
        verificationMode: "run_tests",
        targetArtifacts: ["docs/blueprint.md"],
      },
    },
    {
      kind: "delegation-start",
      goal: "Clarify brand colors",
      depth: 1,
      tools: ["ask_user"],
      agentName: "Clarifier",
    },
    { kind: "delegation-iteration", depth: 1, iteration: 1, maxIterations: 4 },
    { kind: "iteration", current: 1, max: 20 },
    { kind: "thinking", text: "Need brand colors before locking the contact form chrome." },
    llmReq(0, base, 7),
    llmRes(0, { toolCalls: [tcAsk] }),
    {
      kind: "tool-call",
      invocationId: "k-inv-ask",
      toolCallId: "k-tc-ask",
      tool: "ask_user",
      argsSummary: "brand colors?",
      argsFormatted: JSON.stringify(tcAsk.arguments),
    },
    {
      kind: "user-input-request",
      question: "Which brand colors should the contact form use?",
      options: ["navy/cream", "black/white", "forest/sand"],
    },
    { kind: "user-input-response", text: "Use navy and cream." },
    {
      kind: "tool-result",
      invocationId: "k-inv-ask",
      toolCallId: "k-tc-ask",
      text: "Use navy and cream.",
    },
    { kind: "delegation-end", depth: 1, status: "done", answer: "navy/cream" },
    {
      kind: "planner-delegation-iteration",
      stepName: "blueprint_site",
      depth: 1,
      iteration: 2,
      maxIterations: 14,
      toolNames: ["write_file"],
      content: "Writing blueprint…",
    },
    { kind: "nudge", tag: "progress", message: "Keep artifacts under site/", iteration: 1 },
    {
      kind: "planner-delegation-end",
      stepName: "blueprint_site",
      depth: 1,
      status: "done",
      answer: "Blueprint ready",
    },
    {
      kind: "planner-step-end",
      stepName: "blueprint_site",
      status: "pass",
      durationMs: 2200,
      producedArtifacts: ["docs/blueprint.md"],
    },
    { kind: "planner-step-start", stepName: "schema_layer", stepType: "subagent_task" },
    {
      kind: "planner-delegation-start",
      goal: "Schema + sample query",
      stepName: "schema_layer",
      depth: 1,
      tools: ["query_mssql", "write_file"],
      budget: budget(),
      envelope: { targetArtifacts: ["db/clients.sql"] },
    },
    { kind: "iteration", current: 2, max: 20 },
    llmReq(1, afterAsk, 7),
    llmRes(1, { toolCalls: [tcSqlBad] }),
    {
      kind: "tool-call",
      invocationId: "k-inv-sql-bad",
      toolCallId: "k-tc-sql-bad",
      tool: "query_mssql",
      argsSummary: "SELECT * FROM HugeTable",
      argsFormatted: JSON.stringify(tcSqlBad.arguments),
    },
    emptySqlQuality({
      toolCallId: "k-tc-sql-bad",
      toolName: "query_mssql",
      iteration: 1,
      phase: "blocked",
      validationOk: false,
      validationCode: "MISSING_WHERE",
      hasWhereClause: false,
      unsafeScanReason: "unbounded select",
      rowCount: null,
      error: null,
      sqlPreview: "SELECT * FROM HugeTable",
      sqlLength: 24,
    }),
    {
      kind: "tool-error",
      invocationId: "k-inv-sql-bad",
      toolCallId: "k-tc-sql-bad",
      text: "Blocked by SQL quality: MISSING_WHERE",
    },
    { kind: "iteration", current: 3, max: 20 },
    llmReq(2, afterSql, 7),
    llmRes(2, { toolCalls: [tcSqlOk] }),
    {
      kind: "tool-call",
      invocationId: "k-inv-sql-ok",
      toolCallId: "k-tc-sql-ok",
      tool: "query_mssql",
      argsSummary: "SELECT TOP 10…",
      argsFormatted: JSON.stringify(tcSqlOk.arguments),
    },
    emptySqlQuality({
      toolCallId: "k-tc-sql-ok",
      toolName: "query_mssql",
      iteration: 2,
      phase: "executed",
      sqlPreview: String(tcSqlOk.arguments.sql),
      sqlLength: String(tcSqlOk.arguments.sql).length,
      rowCount: 10,
      durationMs: 45,
    }),
    {
      kind: "tool-result",
      invocationId: "k-inv-sql-ok",
      toolCallId: "k-tc-sql-ok",
      text: "10 rows returned",
    },
    {
      kind: "planner-delegation-end",
      stepName: "schema_layer",
      depth: 1,
      status: "done",
      answer: "Schema queries safe",
    },
    {
      kind: "planner-step-end",
      stepName: "schema_layer",
      status: "pass",
      durationMs: 1800,
    },
    { kind: "planner-step-start", stepName: "api_layer", stepType: "subagent_task" },
    {
      kind: "delegation-parallel-start",
      depth: 1,
      taskCount: 2,
      goals: ["wire contact API", "preview sync plan"],
    },
    { kind: "iteration", current: 4, max: 20 },
    llmReq(3, afterSqlOk, 7),
    llmRes(3, { toolCalls: [tcSync] }),
    {
      kind: "tool-call",
      invocationId: "k-inv-sync",
      toolCallId: "k-tc-sync",
      tool: "sync_preview",
      argsSummary: "client 42",
      argsFormatted: JSON.stringify(tcSync.arguments),
    },
    {
      kind: "sync-progress",
      invocationId: "k-inv-sync",
      tool: "sync_preview",
      status: "running",
      headline: "Previewing sync",
      detail: "Scanning clients…",
      level: "info",
      lastTable: { name: "clients", index: 1, total: 2, status: "running" },
    },
    {
      kind: "sync-progress",
      invocationId: "k-inv-sync",
      tool: "sync_preview",
      status: "done",
      headline: "Sync preview complete",
      detail: "2 tables ready",
      result: "Preview complete — plan plan-dem: +3 ~1 -0",
      lastTable: { name: "orders", index: 2, total: 2, insert: 3, update: 1, delete: 0, status: "done" },
      sql: {
        label: "preview",
        connection: "dev",
        preview: "SELECT COUNT(*) FROM clients",
        rowCount: 1,
        durationMs: 8,
      },
    },
    {
      kind: "tool-result",
      invocationId: "k-inv-sync",
      toolCallId: "k-tc-sync",
      text: "Plan plan-demo — client 42\n  dev → uat\n  Totals: +3 ~1 -0 (=0 unchanged) across 2 table(s)",
    },
    {
      kind: "delegation-parallel-end",
      depth: 1,
      taskCount: 2,
      fulfilled: 2,
      rejected: 0,
    },
    {
      kind: "planner-step-end",
      stepName: "api_layer",
      status: "pass",
      durationMs: 1100,
    },
    { kind: "planner-step-start", stepName: "frontend_layer", stepType: "subagent_task" },
    {
      kind: "planner-delegation-start",
      goal: "Ship contact form page",
      stepName: "frontend_layer",
      depth: 1,
      tools: ["write_file", "run_command"],
      budget: budget({ hasComplexImplementation: true }),
      envelope: { targetArtifacts: ["site/contact.html"] },
    },
    { kind: "iteration", current: 5, max: 20 },
    llmReq(4, afterSync, 7),
    llmRes(4, { toolCalls: [tcWrite] }),
    {
      kind: "tool-call",
      invocationId: "k-inv-write",
      toolCallId: "k-tc-write",
      tool: "write_file",
      argsSummary: "site/contact.html",
      argsFormatted: JSON.stringify(tcWrite.arguments),
    },
    {
      kind: "tool-result",
      invocationId: "k-inv-write",
      toolCallId: "k-tc-write",
      text: "Wrote site/contact.html",
    },
    { kind: "iteration", current: 6, max: 20 },
    llmReq(5, afterWrite, 7),
    llmRes(5, { toolCalls: [tcBoom] }),
    {
      kind: "tool-call",
      invocationId: "k-inv-boom",
      toolCallId: "k-tc-boom",
      tool: "run_command",
      argsSummary: "npm run build",
      argsFormatted: JSON.stringify(tcBoom.arguments),
    },
    {
      kind: "tool-error",
      invocationId: "k-inv-boom",
      toolCallId: "k-tc-boom",
      text: "Error: Module not found: './brand-tokens'",
    },
    {
      kind: "planner-delegation-end",
      stepName: "frontend_layer",
      depth: 1,
      status: "error",
      error: "build failed",
    },
    {
      kind: "planner-step-end",
      stepName: "frontend_layer",
      status: "fail",
      durationMs: 2400,
      error: "build failed — missing brand-tokens",
      verificationAttempts: [
        { toolName: "run_command", target: "npm run build", success: false, summary: "Module not found" },
      ],
      reconciliation: {
        compliant: false,
        findings: [{ code: "BUILD_FAIL", severity: "error", message: "Missing brand-tokens module" }],
      },
    },
    {
      kind: "planner-verification",
      overall: "fail",
      confidence: 0.91,
      verifierRound: 1,
      systemChecks: [
        { code: "BUILD", severity: "error", summary: "Frontend build failed", confidence: 0.95 },
      ],
      steps: [
        { stepName: "blueprint_site", outcome: "pass", issues: [] },
        { stepName: "schema_layer", outcome: "pass", issues: [] },
        { stepName: "api_layer", outcome: "pass", issues: [] },
        {
          stepName: "frontend_layer",
          outcome: "fail",
          issues: ["missing brand-tokens"],
          issueCodes: ["BUILD_FAIL"],
        },
      ],
    },
    {
      kind: "planner-issue-timeline",
      attempt: 1,
      verifierRound: 1,
      issues: [
        {
          stepName: "frontend_layer",
          code: "BUILD_FAIL",
          confidence: 0.94,
          ownershipMode: "primary",
          primaryOwner: "frontend_layer",
          suspectedOwners: ["frontend_layer"],
        },
      ],
    },
    {
      kind: "planner-verification-followup",
      requestedSteps: ["frontend_layer"],
      reasons: [
        {
          stepName: "frontend_layer",
          confidence: 0.7,
          ambiguousIssues: ["token path unclear"],
        },
      ],
    },
    {
      kind: "planner-repair-plan",
      attempt: 1,
      epoch: 1,
      rerunOrder: ["frontend_layer"],
      tasks: [
        {
          stepName: "frontend_layer",
          mode: "repair",
          ownedIssueCodes: ["BUILD_FAIL"],
          dependencyIssueCodes: [],
        },
      ],
    },
    {
      kind: "planner-retry",
      attempt: 2,
      reason: "repair_frontend_build",
      skippedSteps: 3,
      retrySteps: 1,
      rerunOrder: ["frontend_layer"],
    },
    { kind: "planner-retry-skip", stepName: "api_layer", reason: "already_passed" },
    {
      kind: "planner-budget-extended",
      completedSteps: 3,
      effectiveBudget: 18,
      extensions: 1,
    },
    { kind: "planner-pipeline-start", attempt: 2, verifierRound: 1, maxRetries: 2 },
    { kind: "planner-step-start", stepName: "frontend_layer", stepType: "subagent_task" },
    {
      kind: "planner-delegation-start",
      goal: "Fix build and finish contact page",
      stepName: "frontend_layer",
      depth: 1,
      tools: ["write_file", "run_command"],
      budget: budget({ complexityBoost: 4, computedMaxIterations: 16 }),
      envelope: { targetArtifacts: ["site/contact.html", "site/brand-tokens.js"], verificationMode: "run_tests" },
    },
    { kind: "iteration", current: 7, max: 20 },
    llmReq(6, afterBoom, 7),
    llmRes(6, { toolCalls: [tcTokens] }),
    {
      kind: "tool-call",
      invocationId: "k-inv-tokens",
      toolCallId: "k-tc-tokens",
      tool: "write_file",
      argsSummary: "site/brand-tokens.js",
      argsFormatted: JSON.stringify(tcTokens.arguments),
    },
    {
      kind: "tool-result",
      invocationId: "k-inv-tokens",
      toolCallId: "k-tc-tokens",
      text: "Wrote site/brand-tokens.js",
    },
    { kind: "iteration", current: 8, max: 20 },
    llmReq(7, afterTokens, 7),
    llmRes(7, { toolCalls: [tcRebuild] }),
    {
      kind: "tool-call",
      invocationId: "k-inv-rebuild",
      toolCallId: "k-tc-rebuild",
      tool: "run_command",
      argsSummary: "npm run build",
      argsFormatted: JSON.stringify(tcRebuild.arguments),
    },
    {
      kind: "tool-result",
      invocationId: "k-inv-rebuild",
      toolCallId: "k-tc-rebuild",
      text: "Build succeeded",
    },
    { kind: "iteration", current: 9, max: 20 },
    llmReq(8, afterRebuild, 7),
    llmRes(8, {
      content:
        "I fixed the missing brand tokens and rebuilt successfully. Contact form is live with navy/cream styling.",
      prompt: 520,
      completion: 80,
    }),
    {
      kind: "planner-delegation-end",
      stepName: "frontend_layer",
      depth: 1,
      status: "done",
      answer: "Build green",
    },
    {
      kind: "planner-step-end",
      stepName: "frontend_layer",
      status: "pass",
      durationMs: 1600,
      producedArtifacts: ["site/contact.html", "site/brand-tokens.js"],
    },
    {
      kind: "planner-verification",
      overall: "pass",
      confidence: 0.88,
      verifierRound: 2,
      steps: [
        { stepName: "blueprint_site", outcome: "pass", issues: [] },
        { stepName: "schema_layer", outcome: "pass", issues: [] },
        { stepName: "api_layer", outcome: "pass", issues: [] },
        { stepName: "frontend_layer", outcome: "pass", issues: [] },
      ],
    },
    {
      kind: "planner-pipeline-end",
      status: "success",
      completedSteps: 4,
      totalSteps: 4,
    },
    {
      kind: "planner-retry-skipped",
      reason: "pipeline_succeeded",
    },
    {
      kind: "direct_loop_fallback",
      source: "planner_declined",
      reason: "unused_in_this_run_but_tracked",
    },
    {
      kind: "usage",
      iterationTokens: 600,
      totalTokens: 4800,
      promptTokens: 3200,
      completionTokens: 1600,
      llmCalls: 9,
    },
    {
      kind: "answer",
      text: "Site is ready: landing/about/contact with navy/cream branding. Schema, sync preview, and build all passed after one repair round.",
    },
    {
      kind: "workspace_diff",
      diff: {
        added: ["docs/blueprint.md", "site/contact.html", "site/brand-tokens.js", "db/clients.sql"],
        modified: ["package.json"],
        deleted: [],
      },
    },
    { kind: "workspace_diff_applied", summary: { added: 4, modified: 1, deleted: 0 } },
  ]
}

function persistRun(opts: {
  id: string
  threadId: string
  upn: string
  goal: string
  answer: string
  stepCount: number
  createdOffset: number
  completedOffset: number
  displayName: string
  trace: TraceEntry[]
}) {
  saveRun({
    id: opts.id,
    goal: opts.goal,
    status: "completed",
    answer: opts.answer,
    step_count: opts.stepCount,
    error: null,
    parent_run_id: null,
    created_at: iso(opts.createdOffset),
    completed_at: iso(opts.completedOffset),
    thread_id: opts.threadId,
    upn: opts.upn,
    display_name: opts.displayName,
  })

  opts.trace.forEach((entry, seq) => {
    saveTraceEntry({
      run_id: opts.id,
      seq,
      data: JSON.stringify(entry),
      created_at: iso(opts.createdOffset + seq * 400),
    })
  })
}

const thread = createThread(upn, "Demo Trace — Direct / Planner / Kitchen sink")
touchThread(thread.id)

const run1 = randomUUID()
const run2 = randomUUID()
const run3 = randomUUID()

const directTrace = buildDirectFourCalls()
const plannerTrace = buildPlannerFiveCalls()
const kitchenTrace = buildKitchenSink()

persistRun({
  id: run1,
  threadId: thread.id,
  upn,
  goal: "List top bankers and export a small CSV summary",
  answer: "Top 5 bankers exported to top-bankers.csv.",
  stepCount: 3,
  createdOffset: -180_000,
  completedOffset: -150_000,
  displayName: users.find((u) => u.upn === upn)?.display_name ?? upn,
  trace: directTrace,
})

persistRun({
  id: run2,
  threadId: thread.id,
  upn,
  goal:
    "Build a small dashboard site with a landing page, metrics page, and export endpoint. Create the schema, API, then frontend.",
  answer: "Dashboard schema, API, and frontend are in place.",
  stepCount: 8,
  createdOffset: -120_000,
  completedOffset: -60_000,
  displayName: users.find((u) => u.upn === upn)?.display_name ?? upn,
  trace: plannerTrace,
})

persistRun({
  id: run3,
  threadId: thread.id,
  upn,
  goal:
    "Create a website with landing, about, and contact form. First schema, then API, then frontend — verify and repair if needed.",
  answer:
    "Site is ready: landing/about/contact with navy/cream branding. Schema, sync preview, and build all passed after one repair round.",
  stepCount: 18,
  createdOffset: -50_000,
  completedOffset: -5_000,
  displayName: users.find((u) => u.upn === upn)?.display_name ?? upn,
  trace: kitchenTrace,
})

touchThread(thread.id)

console.log(`Database: ${getDbPath()}`)
console.log(`User:     ${upn}`)
console.log(`Thread:   ${thread.id}`)
console.log(`  Run 1 (direct, 4 LLM):   ${run1}  — ${directTrace.length} trace entries`)
console.log(`  Run 2 (planner, 5 LLM):  ${run2}  — ${plannerTrace.length} trace entries`)
console.log(`  Run 3 (kitchen sink):    ${run3}  — ${kitchenTrace.length} trace entries`)
console.log("\nOpen the thread in chat / Trace widget to inspect.")
