// Unit tests for clarification detectors.
//
// Each detector is exercised in isolation with the smallest CatalogGraph
// / context that exposes its trigger condition. The fixture builder
// below mints purpose-built micro-catalogs so a single test failure
// points unambiguously at one detector.

import { describe, expect, it } from "vitest"

import { emptyResultDetector } from "../../src/clarify/detectors/empty-result.js"
import { grainUndefinedDetector } from "../../src/clarify/detectors/grain-undefined.js"
import { metricUndefinedDetector } from "../../src/clarify/detectors/metric-undefined.js"
import { outputFormatDetector } from "../../src/clarify/detectors/output-format.js"
import { schemaMatchDetector } from "../../src/clarify/detectors/schema-match.js"
import { termUndefinedDetector } from "../../src/clarify/detectors/term-undefined.js"
import { timeRangeDetector } from "../../src/clarify/detectors/time-range.js"
import { writeConfirmationDetector } from "../../src/clarify/detectors/write-confirmation.js"
import type { ClarifyContext } from "../../src/clarify/types.js"
import { DEFAULT_TENANT_CONFIG, type TenantConfig } from "../../src/tenant/config.js"
import { CatalogGraph } from "../../src/tools/catalog/graph/index.js"
import type { CatalogColumn, CatalogTable } from "../../src/tools/catalog/types.js"

// ── Fixture helpers ─────────────────────────────────────────────

function col(name: string, dataType = "int"): CatalogColumn {
  return { name, dataType, nullable: false, isPK: false, maxLength: null }
}

function table(schema: string, name: string, columns: CatalogColumn[] = [], type: "TABLE" | "VIEW" = "TABLE", viewDefinition?: string): CatalogTable {
  return {
    schema, name,
    qualifiedName: `${schema}.${name}`,
    type,
    rowCount: type === "TABLE" ? 1000 : null,
    columns,
    fkOutgoing: [],
    fkIncoming: [],
    viewDefinition,
  }
}

function catalogFrom(tables: CatalogTable[]): CatalogGraph {
  return CatalogGraph.fromSnapshot({
    version: 6,
    builtAt: new Date().toISOString(),
    source: "test",
    tables,
    implicitEdges: [],
    lineage: [],
    viewSourceRows: [],
    sysCatalog: [],
  } as Parameters<typeof CatalogGraph.fromSnapshot>[0])
}

function ctx(overrides: Partial<ClarifyContext> & Pick<ClarifyContext, "goal">): ClarifyContext {
  return {
    catalog: null,
    tenant: DEFAULT_TENANT_CONFIG,
    messages: [],
    resolved: [],
    round: 1,
    ...overrides,
  }
}

// ── schema-match ─────────────────────────────────────────────────

describe("schemaMatchDetector", () => {
  it("fires when a goal token matches multiple catalog identifiers", () => {
    const cat = catalogFrom([
      table("publish", "Revenue", [col("amount", "decimal")]),
      table("core", "RevenueRaw", [col("amount", "decimal")]),
      table("staging", "RevenueIn", [col("amount", "decimal")]),
    ])
    const findings = schemaMatchDetector.detect(ctx({ goal: "show top revenue", catalog: cat }))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.id).toBe("schema-match:revenue")
    expect(findings[0]!.severity).toBe("block")
    expect(findings[0]!.candidates).toEqual(expect.arrayContaining(["publish.Revenue", "core.RevenueRaw", "staging.RevenueIn"]))
  })

  it("stays silent when a token matches exactly one identifier", () => {
    const cat = catalogFrom([table("publish", "Sales", [col("amount", "decimal")])])
    expect(schemaMatchDetector.detect(ctx({ goal: "show sales totals", catalog: cat }))).toEqual([])
  })

  it("stays silent when no catalog is available", () => {
    expect(schemaMatchDetector.detect(ctx({ goal: "show top revenue" }))).toEqual([])
  })

  it("ignores stop-words even when they happen to be column tokens", () => {
    // "show" is a stopword — even if some weird catalog has a `show` column,
    // the detector should not fire on framing language.
    const cat = catalogFrom([
      table("a", "Foo", [col("show", "int")]),
      table("b", "Bar", [col("show", "int")]),
    ])
    expect(schemaMatchDetector.detect(ctx({ goal: "show me data", catalog: cat }))).toEqual([])
  })
})

// ── term-undefined ───────────────────────────────────────────────

describe("termUndefinedDetector", () => {
  it("fires when a capitalised phrase has no catalog or tenant grounding", () => {
    const cat = catalogFrom([table("publish", "Sales", [col("amount", "decimal")])])
    const findings = termUndefinedDetector.detect(ctx({ goal: "Give me Corporate Banking results", catalog: cat }))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.subject).toBe("Corporate Banking")
    expect(findings[0]!.severity).toBe("block")
  })

  it("stays silent when the phrase is in tenant routingKeywords.domain", () => {
    const cat = catalogFrom([table("publish", "Sales", [col("amount", "decimal")])])
    const tenant: TenantConfig = { ...DEFAULT_TENANT_CONFIG, routingKeywords: { schemas: [], domain: ["corporate"], sync: [] } }
    expect(termUndefinedDetector.detect(ctx({ goal: "Give me Corporate results", catalog: cat, tenant }))).toEqual([])
  })

  it("stays silent when a token of the phrase matches a catalog identifier", () => {
    const cat = catalogFrom([table("publish", "Revenue", [col("amount", "decimal")])])
    expect(termUndefinedDetector.detect(ctx({ goal: "Give me Revenue Breakdown", catalog: cat }))).toEqual([])
  })

  it("ignores common sentence-starter capitalised words like Show / How", () => {
    const cat = catalogFrom([table("publish", "Sales", [col("amount", "decimal")])])
    expect(termUndefinedDetector.detect(ctx({ goal: "Show me sales", catalog: cat }))).toEqual([])
    expect(termUndefinedDetector.detect(ctx({ goal: "How are sales?", catalog: cat }))).toEqual([])
  })
})

// ── metric-undefined ─────────────────────────────────────────────

describe("metricUndefinedDetector", () => {
  it("fires on ranking language with no metric column named", () => {
    const cat = catalogFrom([table("publish", "Sales", [col("name", "nvarchar")])])
    const findings = metricUndefinedDetector.detect(ctx({ goal: "show top 10 records", catalog: cat }))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.subject).toBe("top")
    expect(findings[0]!.severity).toBe("warn")
  })

  it("stays silent when a numeric column is named in the goal", () => {
    const cat = catalogFrom([table("publish", "Sales", [col("revenue", "decimal")])])
    expect(metricUndefinedDetector.detect(ctx({ goal: "show top 10 by revenue", catalog: cat }))).toEqual([])
  })

  it("ignores numeric tokens that are not numeric columns", () => {
    const cat = catalogFrom([table("publish", "Sales", [col("name", "nvarchar")])])
    // "name" is not numeric → metric still undefined
    expect(metricUndefinedDetector.detect(ctx({ goal: "show top 10 by name", catalog: cat }))).toHaveLength(1)
  })
})

// ── grain-undefined ──────────────────────────────────────────────

describe("grainUndefinedDetector", () => {
  it("fires when a period word matches multiple grain columns", () => {
    const cat = catalogFrom([
      table("dim", "Date", [col("pkMonth", "int"), col("pkAccountingMonth", "int"), col("pkReportingMonth", "int")]),
    ])
    const findings = grainUndefinedDetector.detect(ctx({ goal: "summarise revenue monthly", catalog: cat }))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.subject).toBe("month")
    expect(findings[0]!.candidates).toEqual(expect.arrayContaining(["pkmonth", "pkaccountingmonth", "pkreportingmonth"]))
  })

  it("stays silent when only one grain column matches", () => {
    const cat = catalogFrom([table("dim", "Date", [col("pkMonth", "int")])])
    expect(grainUndefinedDetector.detect(ctx({ goal: "by month please", catalog: cat }))).toEqual([])
  })

  it("stays silent when no period word is in the goal", () => {
    const cat = catalogFrom([table("dim", "Date", [col("pkMonth", "int"), col("pkAccountingMonth", "int")])])
    expect(grainUndefinedDetector.detect(ctx({ goal: "show revenue", catalog: cat }))).toEqual([])
  })
})

// ── time-range ───────────────────────────────────────────────────

describe("timeRangeDetector", () => {
  it("fires on vague time language with no anchor date", () => {
    const findings = timeRangeDetector.detect(ctx({ goal: "show recent revenue" }))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.subject).toMatch(/recent/i)
  })

  it("fires on 'last year' with no year anchor", () => {
    expect(timeRangeDetector.detect(ctx({ goal: "show me last year's totals" }))).toHaveLength(1)
  })

  it("stays silent when a year anchor is present", () => {
    expect(timeRangeDetector.detect(ctx({ goal: "show recent revenue in 2024" }))).toEqual([])
  })

  it("stays silent on precise ISO date ranges", () => {
    expect(timeRangeDetector.detect(ctx({ goal: "show recent revenue between 2024-01-01 and 2024-12-31" }))).toEqual([])
  })
})

// ── output-format ────────────────────────────────────────────────

describe("outputFormatDetector", () => {
  it("fires on 'summarise' with no format hint", () => {
    const findings = outputFormatDetector.detect(ctx({ goal: "summarise client activity" }))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.subject).toBe("summarise")
  })

  it("stays silent when a format word is present", () => {
    expect(outputFormatDetector.detect(ctx({ goal: "summarise client activity as a bar chart" }))).toEqual([])
    expect(outputFormatDetector.detect(ctx({ goal: "give me an overview as a table" }))).toEqual([])
  })

  it("stays silent on plain non-summary goals", () => {
    expect(outputFormatDetector.detect(ctx({ goal: "list top 10 clients" }))).toEqual([])
  })
})

// ── write-confirmation ───────────────────────────────────────────

describe("writeConfirmationDetector", () => {
  it("fires on INSERT INTO a real table", () => {
    const findings = writeConfirmationDetector.detect(ctx({
      goal: "load data",
      lastSqlText: "INSERT INTO publish.Audit (msg) VALUES ('hi')",
    }))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.severity).toBe("block")
    expect(findings[0]!.subject).toMatch(/INSERT INTO publish\.Audit/i)
  })

  it("stays silent on INSERT INTO a #temp table", () => {
    expect(writeConfirmationDetector.detect(ctx({
      goal: "stage data",
      lastSqlText: "INSERT INTO #stage (msg) VALUES ('hi')",
    }))).toEqual([])
  })

  it("fires on DROP TABLE", () => {
    const findings = writeConfirmationDetector.detect(ctx({
      goal: "clean up",
      lastSqlText: "DROP TABLE publish.LegacyArchive",
    }))
    expect(findings).toHaveLength(1)
  })

  it("stays silent on pure SELECT", () => {
    expect(writeConfirmationDetector.detect(ctx({
      goal: "show",
      lastSqlText: "SELECT TOP 10 * FROM publish.Revenue",
    }))).toEqual([])
  })

  it("stays silent when there is no lastSqlText", () => {
    expect(writeConfirmationDetector.detect(ctx({ goal: "show" }))).toEqual([])
  })
})

// ── empty-result ─────────────────────────────────────────────────

describe("emptyResultDetector", () => {
  it("fires on '0 rows' result text", () => {
    const findings = emptyResultDetector.detect(ctx({ goal: "show revenue", lastToolResultText: "Query returned 0 rows." }))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.severity).toBe("warn")
  })

  it("fires on 'no results' phrasing", () => {
    expect(emptyResultDetector.detect(ctx({ goal: "show revenue", lastToolResultText: "no results found" }))).toHaveLength(1)
  })

  it("fires on empty JSON array literal", () => {
    expect(emptyResultDetector.detect(ctx({ goal: "show revenue", lastToolResultText: "[]" }))).toHaveLength(1)
  })

  it("stays silent on non-empty result text", () => {
    expect(emptyResultDetector.detect(ctx({ goal: "show revenue", lastToolResultText: "12 rows returned" }))).toEqual([])
  })

  it("stays silent when there is no lastToolResultText", () => {
    expect(emptyResultDetector.detect(ctx({ goal: "show revenue" }))).toEqual([])
  })
})
