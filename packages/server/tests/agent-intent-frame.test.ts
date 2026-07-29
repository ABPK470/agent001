/**
 * Golden goals — run frame, tool gating, and catalog-clarify must/must-not.
 *
 * Locks the agent-intent confidence work: wrong frame must fail CI before
 * "feels smarter" prompt tweaks reintroduce DB bias.
 */

import {
  detectAmbiguities,
  filterFindingsForRunFrame,
  type AmbiguityFinding,
  type ClarifyContext
} from "@mia/agent"
import { resetTenantConfig, setMssqlConfigs, configureAgent, type AgentHost } from "@mia/agent"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  _resetDecideSectionsCache,
  classifyGoal,
  decideSections,
  DB_DISCOVERY_TOOL_NAMES,
  filterToolsByGoal,
  SYNC_CAPABILITY_TOOL_NAMES,
  type RunFrame
} from "../src/runtime/prompting/decide-sections.js"

const host: AgentHost = configureAgent({})

function emptyTier() {
  return { working: "", episodic: "", semantic: "" }
}

beforeEach(() => {
  resetTenantConfig()
  setMssqlConfigs(host, [])
  _resetDecideSectionsCache()
})

afterEach(() => {
  resetTenantConfig()
  setMssqlConfigs(host, [])
  _resetDecideSectionsCache()
})

const DATA_TOOLS = [
  { name: "query_mssql" },
  { name: "search_catalog" },
  { name: "explore_mssql_schema" },
  { name: "sync_preview" },
  { name: "render_html" }
]

function expectFrame(goal: string, frame: RunFrame, context?: string): void {
  const c = classifyGoal(goal, context)
  expect(c.frame, `frame for: ${goal}`).toBe(frame)
  const d = decideSections({ goal, memory: emptyTier(), context })
  expect(d.frame, `decideSections.frame for: ${goal}`).toBe(frame)
}

function expectDataTools(goal: string, keep: boolean, context?: string): void {
  const d = decideSections({ goal, memory: emptyTier(), context })
  const res = filterToolsByGoal(DATA_TOOLS, d)
  if (keep) {
    expect(res.dropped, `should keep DB tools for: ${goal}`).not.toContain("query_mssql")
    expect(res.tools.some((t) => t.name === "query_mssql")).toBe(true)
  } else {
    for (const name of DB_DISCOVERY_TOOL_NAMES) {
      if (DATA_TOOLS.some((t) => t.name === name)) {
        expect(res.dropped, `should drop ${name} for: ${goal}`).toContain(name)
      }
    }
    expect(res.tools.map((t) => t.name)).toContain("render_html")
  }
}

describe("golden frames — reported failures", () => {
  it("ADO / secrets / defaults discussion is ops_config (not warehouse)", () => {
    const goal =
      "The defaults declare secrets in an array — how should we wire that in Azure DevOps?"
    expectFrame(goal, "ops_config")
    expectDataTools(goal, false)
    const d = decideSections({ goal, memory: emptyTier() })
    expect(d.includeDataPersona).toBe(false)
    expect(d.includeMssqlCatalog).toBe(false)
    expect(d.includeMssqlKnowledge).toBe(false)
  })

  it("mid-thread config chat does not inherit DB mode from prior query_mssql", () => {
    const goal = "Defaults declare secrets in an array — discuss with Azure DevOps pipelines"
    const context = "Step 2: query_mssql({ sql: 'select * from publish.Revenue' })"
    expectFrame(goal, "ops_config", context)
    expectDataTools(goal, false, context)
  })

  it("biggest core schema tables is data_query with schemaAggregate", () => {
    const goal = "what are the biggest core schema tables in dev"
    const c = classifyGoal(goal)
    expect(c.frame).toBe("data_query")
    expect(c.schemaAggregate).toBe(true)
    expectDataTools(goal, true)
    const d = decideSections({ goal, memory: emptyTier() })
    expect(d.schemaAggregate).toBe(true)
    expect(d.includeDataPersona).toBe(true)
  })
})

describe("golden frames — near misses", () => {
  it("explicit SQL stays data_query", () => {
    expectFrame("select top 10 from publish.Revenue", "data_query")
    expectDataTools("select top 10 from publish.Revenue", true)
  })

  it("BI ranking language stays data_query", () => {
    expectFrame("list top 3 products based on revenue for April 2025", "data_query")
  })

  it("cross-env drift stays sync", () => {
    expectFrame("what is out of sync between uat and dev?", "sync")
    const d = decideSections({
      goal: "what is out of sync between uat and dev?",
      memory: emptyTier()
    })
    const res = filterToolsByGoal(
      [...DATA_TOOLS, ...[...SYNC_CAPABILITY_TOOL_NAMES].map((name) => ({ name }))],
      d
    )
    expect(res.tools.some((t) => t.name === "sync_preview")).toBe(true)
  })

  it("casual greeting stays general", () => {
    expectFrame("hi", "general")
    expectDataTools("hi", false)
  })

  it("anaphora after DB work keeps data_query", () => {
    const goal = "and the same for February?"
    const context = "Step 3: query_mssql({connection: 'dev', sql: 'select ...'})"
    expectFrame(goal, "data_query", context)
    expectDataTools(goal, true, context)
  })

  it("run it after SQL context keeps data_query", () => {
    const goal = "could you run it and return me the results?"
    const context = "Prior turn: select top 5 from publish.Revenue group by pkClient"
    expectFrame(goal, "data_query", context)
  })

  it("Monte Carlo stays general despite BI nouns", () => {
    expectFrame("Monte Carlo portfolio simulation with risk and volatility", "general")
    expectDataTools("Monte Carlo portfolio simulation with risk and volatility", false)
  })

  it("markdown table follow-up stays general", () => {
    expectFrame("make the table prettier", "general")
  })

  it("list tables in the database is data_query", () => {
    expectFrame("list every table in the database", "data_query")
  })

  it("bare schema word without compound stays general", () => {
    // Weak lexicon alone must not flip the frame.
    const c = classifyGoal("update the schema docs in the README")
    expect(c.frame).toBe("general")
    expect(c.isDbLike).toBe(false)
  })
})

describe("golden clarify gating", () => {
  const fakeFinding = (kind: AmbiguityFinding["kind"], subject: string): AmbiguityFinding => ({
    id: `${kind}:${subject}`,
    kind,
    severity: "block",
    subject,
    reasoning: "test",
    suggestedQuestion: `Which table for ${subject}?`,
    source: "detector"
  })

  it("strips catalog BLOCK findings on general / ops_config frames", () => {
    const findings = [
      fakeFinding("term-undefined", "Defaults"),
      fakeFinding("schema-match", "core"),
      fakeFinding("write-confirmation", "insert")
    ]
    const general = filterFindingsForRunFrame(findings, {
      runFrame: "general",
      goal: "Defaults in Azure DevOps"
    })
    expect(general.map((f) => f.kind)).toEqual(["write-confirmation"])

    const ops = filterFindingsForRunFrame(findings, {
      runFrame: "ops_config",
      goal: "Defaults declare secrets in an array for Azure DevOps"
    })
    expect(ops.map((f) => f.kind)).toEqual(["write-confirmation"])
  })

  it("keeps catalog findings on data_query frame", () => {
    const findings = [fakeFinding("schema-match", "Revenue")]
    const kept = filterFindingsForRunFrame(findings, {
      runFrame: "data_query",
      goal: "show Revenue"
    })
    expect(kept).toHaveLength(1)
  })

  it("schemaAggregate suppresses schema-match on schema token and tables", () => {
    const findings = [
      fakeFinding("schema-match", "core"),
      fakeFinding("schema-match", "tables"),
      fakeFinding("schema-match", "Revenue")
    ]
    const kept = filterFindingsForRunFrame(findings, {
      runFrame: "data_query",
      schemaAggregate: true,
      goal: "what are the biggest core schema tables in dev"
    })
    expect(kept.map((f) => f.subject)).toEqual(["Revenue"])
  })

  it("detectAmbiguities returns no catalog findings for ops_config even with catalog stub", () => {
    // Minimal stub: detectors that need catalog no-op or produce findings;
    // frame filter must clear catalog kinds regardless.
    const ctx = {
      goal: "Defaults declare secrets in an array — Azure DevOps wiring",
      catalog: null,
      tenant: { domainKeywords: [] as string[], mirrorSchema: null as string | null },
      publishedSyncEntityIds: [] as string[],
      messages: [],
      resolved: [],
      round: 0,
      runFrame: "ops_config" as const
    } as unknown as ClarifyContext
    const findings = detectAmbiguities(ctx)
    expect(findings.every((f) => f.kind !== "term-undefined" && f.kind !== "schema-match")).toBe(
      true
    )
  })
})
