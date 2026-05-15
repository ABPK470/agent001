/**
 * Prompt-token-diet — section gating + dedupe + cache hint behaviour.
 *
 * Locks the wins from `feat/prompt-token-diet`:
 *   1. `decideSections` excludes MSSQL guidance / knowledge / catalog
 *      and the chart catalogue from non-DB / non-visual goals.
 *   2. The MSSQL knowledge body is content-hash de-duplicated across
 *      multiple connections that share the same body (the [uat]+[prod]
 *      case shipping the body twice was the single biggest waste).
 *   3. The final system message carries `cacheHint: "ephemeral"` so
 *      providers that honour Anthropic-style cache_control can serve
 *      the prefix from cache on calls 2..N.
 */

import type { Tool } from "@mia/agent"
import { setMssqlConfigs } from "@mia/agent"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { decideSections } from "../src/orchestrator/decide-sections.js"
import { buildSystemMessages } from "../src/orchestrator/system-messages.js"
import { buildToolContext } from "../src/prompt-builder.js"
import type { RunWorkspaceContext } from "../src/run-workspace.js"

const RW: RunWorkspaceContext = {
  runId:         "run-x",
  sourceRoot:    "/tmp/agent-test-src",
  executionRoot: "/tmp/agent-test-src",
  taskType:      "analysis_or_chat",
  isolated:      false,
  profile:       "developer",
}

function emptyTier() { return { working: "", episodic: "", semantic: "" } }

describe("decideSections", () => {
  it("turns OFF every gate for a casual / log-inspection goal", () => {
    const d = decideSections({ goal: "what can you tell me about these logs?", memory: emptyTier() })
    expect(d.includeMssqlGuidance ).toBe(false)
    expect(d.includeMssqlKnowledge).toBe(false)
    expect(d.includeMssqlCatalog  ).toBe(false)
    expect(d.includeChartCatalogue).toBe(false)
    expect(d.includeAbiSync       ).toBe(false)
    expect(d.includeMemoryGuidance).toBe(false)
  })

  it("does NOT trigger DB gates for unqualified 'table' references (markdown / ASCII tables)", () => {
    // Regression: bare "table"/"tables" used to be in DB_RE and would ship
    // the entire ~30K MSSQL knowledge body for any follow-up that referred
    // to a previously-rendered markdown table.
    for (const goal of [
      "exclude node_modules and re-create the table you just did",
      "render the table again, sorted by lines of code",
      "make the table prettier",
      "show me a table of the top files by size",
      "paste that table into the README",
    ]) {
      const d = decideSections({ goal, memory: emptyTier() })
      expect(d.includeMssqlKnowledge, `goal: ${goal}`).toBe(false)
      expect(d.includeMssqlCatalog,   `goal: ${goal}`).toBe(false)
      expect(d.includeMssqlGuidance,  `goal: ${goal}`).toBe(false)
    }
  })

  it("DOES trigger DB gates when 'table' is qualified by a DB hint", () => {
    for (const goal of [
      "list every table in the database",
      "describe table publish.Revenue",
      "which tables join to dim.Client?",
      "rows in the dim.Client table",
    ]) {
      const d = decideSections({ goal, memory: emptyTier() })
      expect(d.includeMssqlKnowledge, `goal: ${goal}`).toBe(true)
    }
  })

  it("turns ON DB gates for an obvious DB goal — but NOT the chart catalogue", () => {
    // DB-shaped goal without explicit visual intent must NOT ship the
    // chart catalogue. The model can fetch it via `get_chart_specs` if
    // it decides a visualisation is warranted.
    const d = decideSections({ goal: "select the top 10 clients from publish.Revenue", memory: emptyTier() })
    expect(d.includeMssqlGuidance ).toBe(true)
    expect(d.includeMssqlKnowledge).toBe(true)
    expect(d.includeMssqlCatalog  ).toBe(true)
    expect(d.includeChartCatalogue).toBe(false)
    expect(d.includeAbiSync       ).toBe(false)
  })

  it("DB goal WITH an explicit chart word still ships the catalogue", () => {
    const d = decideSections({ goal: "chart the top 10 clients from publish.Revenue", memory: emptyTier() })
    expect(d.includeMssqlGuidance ).toBe(true)
    expect(d.includeChartCatalogue).toBe(true)
  })

  it("turns ON ABI sync for explicit sync intent", () => {
    const d = decideSections({ goal: "sync_preview entity=dataset source=uat target=prod", memory: emptyTier() })
    expect(d.includeAbiSync       ).toBe(true)
    expect(d.includeMssqlGuidance ).toBe(true)
  })

  it("turns ON chart catalogue for an explicit chart request", () => {
    const d = decideSections({ goal: "render a relationships diagram of the order schema", memory: emptyTier() })
    expect(d.includeChartCatalogue).toBe(true)
  })

  it("includes memory guidance only when at least one tier is present", () => {
    expect(decideSections({ goal: "hi", memory: emptyTier()                                }).includeMemoryGuidance).toBe(false)
    expect(decideSections({ goal: "hi", memory: { working: "x", episodic: "", semantic: "" } }).includeMemoryGuidance).toBe(true)
  })
})

describe("DB gating with rendering language (must trigger DB blocks)", () => {
  // The user's chief concern: DWH visualisation questions phrased in
  // natural language with rendering verbs (chart / plot / visualize /
  // dashboard / render / animated) MUST still inject MSSQL knowledge +
  // catalog + guidance. Rendering verbs are orthogonal to data source.
  for (const goal of [
    "Visualize revenue by client as a bar chart by country",
    "Plot AfricaFlex daily balances over the last year",
    "Render a chart of clients by RWA bucket",
    "Show me a dashboard of top 10 merchants this quarter",
    "Animated revenue dashboard with monthly trend",
    "Pie chart of country exposures",
  ]) {
    it(`fires DB gate for: ${goal}`, () => {
      const d = decideSections({ goal, memory: emptyTier() })
      expect(d.includeMssqlKnowledge, `goal: ${goal}`).toBe(true)
      expect(d.includeMssqlGuidance,  `goal: ${goal}`).toBe(true)
      expect(d.includeMssqlCatalog,   `goal: ${goal}`).toBe(true)
      expect(d.includeChartCatalogue, `goal: ${goal}`).toBe(true)
    })
  }
})

describe("DB gating false-positives (must NOT trigger DB blocks)", () => {
  // Pure non-warehouse task types: Monte Carlo, mockups, finance math.
  for (const goal of [
    "Create a Monte Carlo portfolio simulation with risk and volatility",
    "Build an animated finance simulation HTML page",
    "Show me a markets trading screen mockup with order history",
    "Compute a Sharpe ratio over these returns",
    "Wireframe for a banking dashboard",
  ]) {
    it(`does NOT fire DB gate for: ${goal}`, () => {
      const d = decideSections({ goal, memory: emptyTier() })
      expect(d.includeMssqlKnowledge, `goal: ${goal}`).toBe(false)
      expect(d.includeMssqlCatalog,   `goal: ${goal}`).toBe(false)
      expect(d.includeMssqlGuidance,  `goal: ${goal}`).toBe(false)
    })
  }

  it("operational signal cancels NON_DB cue", () => {
    // A literal SQL query that happens to mention a simulation column
    // must still fire — operational beats the NON_DB down-score.
    const d = decideSections({
      goal: "select top 1 from fact.X where simulation_id = 7",
      memory: emptyTier(),
    })
    expect(d.includeMssqlKnowledge).toBe(true)
    expect(d.includeMssqlGuidance ).toBe(true)
  })
})

describe("scoreDbLikelihood telemetry", () => {
  it("exposes dbScore and triggers on the decision object", () => {
    const d = decideSections({ goal: "select top 10 from publish.Revenue grouped by pkClient", memory: emptyTier() })
    expect(d.dbScore).toBeGreaterThanOrEqual(2)
    expect(d.triggers?.operational).toBe(true)
    expect(d.triggers?.domain     ).toBe(true)
    expect(d.triggers?.nonDb      ).toBe(false)
  })

  it("flags nonDb on a Monte Carlo goal", () => {
    const d = decideSections({ goal: "Monte Carlo portfolio simulation with risk", memory: emptyTier() })
    expect(d.triggers?.nonDb).toBe(true)
    expect(d.triggers?.operational).toBe(false)
    expect(d.dbScore).toBeLessThan(2)
  })
})

describe("buildToolContext gates", () => {
  beforeEach(() => {
    setMssqlConfigs([
      { name: "uat",  server: "h", database: "d", knowledge: "ALPHA-KNOWLEDGE-BODY" },
      { name: "prod", server: "h", database: "d", knowledge: "ALPHA-KNOWLEDGE-BODY" },
    ])
  })
  afterEach(() => {
    setMssqlConfigs([])
  })

  it("emits each unique knowledge body exactly once (single-group case omits the env header)", () => {
    const out = buildToolContext([{ name: "query_mssql" } as Tool], { includeMssqlKnowledge: true, includeMssqlCatalog: false, includeMssqlGuidance: false })
    const occurrences = out.split("ALPHA-KNOWLEDGE-BODY").length - 1
    expect(occurrences).toBe(1)
    // When every connection shares the same body, the per-env header is
    // omitted (it would just say "[uat, prod]" before the only block).
    expect(out).not.toMatch(/\[uat,\s*prod\]/)
  })

  it("emits a per-group env header when bodies differ across connections", () => {
    setMssqlConfigs([
      { name: "uat",  server: "h", database: "d", knowledge: "ALPHA-KNOWLEDGE-BODY" },
      { name: "prod", server: "h", database: "d", knowledge: "ALPHA-KNOWLEDGE-BODY" },
      { name: "dev",  server: "h", database: "d", knowledge: "BETA-DEV-ONLY-BODY" },
    ])
    const out = buildToolContext([{ name: "query_mssql" } as Tool], { includeMssqlKnowledge: true, includeMssqlCatalog: false, includeMssqlGuidance: false })
    expect(out.split("ALPHA-KNOWLEDGE-BODY").length - 1).toBe(1)
    expect(out.split("BETA-DEV-ONLY-BODY").length - 1).toBe(1)
    expect(out).toMatch(/\[uat,\s*prod\]/)
    expect(out).toMatch(/\[dev\]/)
  })

  it("omits the knowledge block when includeMssqlKnowledge is false", () => {
    const out = buildToolContext([{ name: "query_mssql" } as Tool], { includeMssqlKnowledge: false, includeMssqlCatalog: false, includeMssqlGuidance: false })
    expect(out).not.toContain("ALPHA-KNOWLEDGE-BODY")
    expect(out).not.toContain("DATABASE KNOWLEDGE")
  })

  it("omits the SCALE CONTEXT / DATA TOOLS guidance when includeMssqlGuidance is false", () => {
    const out = buildToolContext([{ name: "query_mssql" } as Tool], { includeMssqlKnowledge: false, includeMssqlCatalog: false, includeMssqlGuidance: false })
    expect(out).not.toContain("SCALE CONTEXT")
    expect(out).not.toContain("DATA TOOLS")
  })
})

describe("buildSystemMessages cache hint + section budget", () => {
  it("marks the LAST system message with cacheHint=ephemeral", async () => {
    const messages = await buildSystemMessages({
      goal: "hello", systemPrompt: undefined, allTools: [], runWorkspace: RW, perTier: emptyTier(), runId: "run-x",
    })
    expect(messages.length).toBeGreaterThan(0)
    expect(messages[messages.length - 1].cacheHint).toBe("ephemeral")
    // No earlier system message should also carry the hint (single cache breakpoint).
    for (let i = 0; i < messages.length - 1; i++) {
      expect(messages[i].cacheHint).toBeUndefined()
    }
  })

  it("a casual goal produces a SHORTER prompt than a DB goal (gates are active)", async () => {
    // MSSQL configs must be set so the DB-gate has something material to
    // include (knowledge body + catalogue scaffolding). Without them the
    // gates only differ by the now-removed chart catalogue, and casual
    // vs DB would be byte-identical.
    setMssqlConfigs([
      { name: "uat",  server: "h", database: "d", knowledge: "ALPHA-KNOWLEDGE-BODY" },
      { name: "prod", server: "h", database: "d", knowledge: "ALPHA-KNOWLEDGE-BODY" },
    ])
    try {
      const tools = [{ name: "query_mssql" } as Tool]
      const casual = await buildSystemMessages({ goal: "what can you tell me about these logs?", systemPrompt: undefined, allTools: tools, runWorkspace: RW, perTier: emptyTier(), runId: "r" })
      const db     = await buildSystemMessages({ goal: "select top 10 from publish.Revenue",      systemPrompt: undefined, allTools: tools, runWorkspace: RW, perTier: emptyTier(), runId: "r" })
      const len = (ms: typeof casual) => ms.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0)
      expect(len(casual)).toBeLessThan(len(db))
    } finally {
      setMssqlConfigs([])
    }
  })

  it("a DB goal WITHOUT explicit chart intent ships a SHORTER prompt than the same goal WITH 'chart' (catalogue gate is strict)", async () => {
    setMssqlConfigs([
      { name: "uat", server: "h", database: "d", knowledge: "ALPHA-KNOWLEDGE-BODY" },
    ])
    try {
      const tools = [{ name: "query_mssql" } as Tool]
      const dbOnly  = await buildSystemMessages({ goal: "select top 10 from publish.Revenue",       systemPrompt: undefined, allTools: tools, runWorkspace: RW, perTier: emptyTier(), runId: "r" })
      const dbChart = await buildSystemMessages({ goal: "chart the top 10 from publish.Revenue",    systemPrompt: undefined, allTools: tools, runWorkspace: RW, perTier: emptyTier(), runId: "r" })
      const len = (ms: typeof dbOnly) => ms.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0)
      expect(len(dbOnly)).toBeLessThan(len(dbChart))
    } finally {
      setMssqlConfigs([])
    }
  })
})
