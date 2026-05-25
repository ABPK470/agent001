/**
 * Canonical fixture catalog — installs a synthetic CatalogGraph into the
 * runtime so tests that exercise scan-guards, branch-aggregation guards
 * and persisted-mirror suggestions have realistic catalog data to query
 * (large fact tables, multi-branch UNION views, dimensions with PK/FK
 * relationships, a calendar dimension).
 *
 * The shape mirrors the canonical deployment, but the tests don't depend
 * on the EXACT names — they depend on the SHAPE (a view is "large" because
 * its source rows are large, not because its name is "publish.Revenue").
 *
 * Used by tests/setup.ts (vitest setupFiles). Tests that need a different
 * catalog can call `installFixtureCatalog(myTables)` or
 * `clearFixtureCatalog()` themselves.
 */
import { AgentRuntime } from "../../src/agent-runtime.js"
import { CatalogGraph } from "../../src/tools/catalog/graph/index.js"
import { _resetCatalogQueriesCache } from "../../src/tools/catalog/queries.js"
import type { CatalogFK, CatalogTable } from "../../src/tools/catalog/types.js"

function col(name: string, dataType = "int", isPK = false): { name: string; dataType: string; nullable: boolean; isPK: boolean; maxLength: number | null } {
  return { name, dataType, nullable: false, isPK, maxLength: null }
}

function fk(constraint: string, fromSchema: string, fromTable: string, fromColumn: string, toSchema: string, toTable: string, toColumn: string): CatalogFK {
  return { constraint, fromSchema, fromTable, fromColumn, toSchema, toTable, toColumn }
}

function mkTable(
  schema: string,
  name: string,
  opts: {
    type?: "TABLE" | "VIEW"
    rowCount?: number | null
    columns?: ReturnType<typeof col>[]
    fkOutgoing?: CatalogFK[]
    fkIncoming?: CatalogFK[]
    viewDefinition?: string
  } = {},
): CatalogTable {
  return {
    schema, name,
    qualifiedName: `${schema}.${name}`,
    type: opts.type ?? "TABLE",
    rowCount: opts.rowCount ?? null,
    columns: opts.columns ?? [],
    fkOutgoing: opts.fkOutgoing ?? [],
    fkIncoming: opts.fkIncoming ?? [],
    viewDefinition: opts.viewDefinition,
  }
}

/**
 * Canonical fixture matching the deployment shape: a calendar dim, two
 * large UNION views, a couple of large fact tables, a mirror schema for
 * one of the views, and small ref tables.
 */
export function canonicalFixtureCatalog(): CatalogGraph {
  // Calendar dim — used by dateGrainColumn heuristic
  const dimDate = mkTable("dim", "Date", {
    rowCount: 3000,
    columns: [col("pkMonth", "int", true), col("Year", "int"), col("FullDate", "date")],
  })

  // Centrally-referenced client dim (many incoming FKs ⇒ pkClient is "high-card")
  const dimClient = mkTable("dim", "Client", {
    rowCount: 26_000_000,
    columns: [col("pkClient", "int", true), col("ClientName", "nvarchar")],
  })
  const dimAccount = mkTable("dim", "Account", {
    rowCount: 51_000_000,
    columns: [col("pkAccount", "int", true), col("pkClient", "int")],
  })

  // Source-mapping branches — 12 small fact tables that feed publish.Revenue.
  const revenueBranches: CatalogTable[] = []
  const revenueUnionParts: string[] = []
  for (let i = 0; i < 12; i++) {
    revenueBranches.push(mkTable("publish", `MappingRev${i}`, {
      rowCount: 5_000_000,
      columns: [
        col("pkClient", "int"), col("pkAccount", "int"), col("pkMonth", "int"), col("RevenueZARMTD", "decimal"),
      ],
      fkOutgoing: [fk(`fk_rev${i}_client`, "publish", `MappingRev${i}`, "pkClient", "dim", "Client", "pkClient")],
    }))
    revenueUnionParts.push(`SELECT pkClient, pkAccount, pkMonth, RevenueZARMTD FROM publish.MappingRev${i}`)
  }
  const balanceBranches: CatalogTable[] = []
  const balanceUnionParts: string[] = []
  for (let i = 0; i < 10; i++) {
    balanceBranches.push(mkTable("publish", `MappingBal${i}`, {
      rowCount: 4_000_000,
      columns: [
        col("pkAccount", "int"), col("pkMonth", "int"), col("AverageCreditBalanceZARMTD", "decimal"),
      ],
      fkOutgoing: [fk(`fk_bal${i}_acc`, "publish", `MappingBal${i}`, "pkAccount", "dim", "Account", "pkAccount")],
    }))
    balanceUnionParts.push(`SELECT pkAccount, pkMonth, AverageCreditBalanceZARMTD FROM publish.MappingBal${i}`)
  }

  // Wide UNION views
  const publishRevenue = mkTable("publish", "Revenue", {
    type: "VIEW",
    columns: [col("pkClient", "int"), col("pkAccount", "int"), col("pkMonth", "int"), col("RevenueZARMTD", "decimal")],
    viewDefinition: revenueUnionParts.join("\nUNION ALL\n"),
    fkOutgoing: [fk("fk_rev_client", "publish", "Revenue", "pkClient", "dim", "Client", "pkClient")],
  })
  const publishBalances = mkTable("publish", "Balances", {
    type: "VIEW",
    columns: [col("pkAccount", "int"), col("pkMonth", "int"), col("AverageCreditBalanceZARMTD", "decimal")],
    viewDefinition: balanceUnionParts.join("\nUNION ALL\n"),
    fkOutgoing: [fk("fk_bal_account", "publish", "Balances", "pkAccount", "dim", "Account", "pkAccount")],
  })

  // Persisted mirrors under the "persistedview" schema
  const persistedRevenue = mkTable("persistedview", "publish.Revenue", {
    rowCount: 60_000_000,
    columns: [col("pkClient", "int"), col("pkAccount", "int"), col("pkMonth", "int"), col("RevenueZARMTD", "decimal")],
    fkOutgoing: [fk("fk_persrev_client", "persistedview", "publish.Revenue", "pkClient", "dim", "Client", "pkClient")],
  })
  const persistedBalances = mkTable("persistedview", "publish.Balances", {
    rowCount: 50_000_000,
    columns: [col("pkAccount", "int"), col("pkMonth", "int"), col("AverageCreditBalanceZARMTD", "decimal")],
  })

  // Big fact table for scan-guard tests
  const factUno = mkTable("fact", "UnoTranspose", {
    rowCount: 2_400_000_000,
    columns: [col("pkClient", "int"), col("pkMonth", "int")],
  })

  const tables: CatalogTable[] = [
    dimDate, dimClient, dimAccount,
    ...revenueBranches, ...balanceBranches,
    publishRevenue, publishBalances,
    persistedRevenue, persistedBalances,
    factUno,
  ]

  // Wire dimClient.fkIncoming so highCardinalityKeyColumns sees the central-dim shape.
  dimClient.fkIncoming.push(
    ...revenueBranches.flatMap((t) => t.fkOutgoing),
    publishRevenue.fkOutgoing[0]!,
    persistedRevenue.fkOutgoing[0]!,
  )
  dimAccount.fkIncoming.push(
    ...balanceBranches.flatMap((t) => t.fkOutgoing),
    publishBalances.fkOutgoing[0]!,
  )

  // viewSourceRows: sum of source-table rowCounts
  const viewSourceRows = [
    { name: "publish.Revenue", sourceRows: revenueBranches.reduce((a, t) => a + (t.rowCount ?? 0), 0) },
    { name: "publish.Balances", sourceRows: balanceBranches.reduce((a, t) => a + (t.rowCount ?? 0), 0) },
  ]

  // Lineage so getUnionBranches(publish.Revenue) returns the branch list —
  // derived purely from viewDefinition UNION ALL parsing now.

  return CatalogGraph.fromSnapshot({
    version: 7,
    builtAt: new Date().toISOString(),
    source: "fixture",
    tables,
    implicitEdges: [],
    viewSourceRows,
    sysCatalog: [],
  } as Parameters<typeof CatalogGraph.fromSnapshot>[0])
}

export function installFixtureCatalog(graph: CatalogGraph, connection = "default"): void {
  AgentRuntime.root().catalog.instances.set(connection, graph)
  _resetCatalogQueriesCache()
}

export function installCanonicalFixtureCatalog(): CatalogGraph {
  const g = canonicalFixtureCatalog()
  installFixtureCatalog(g)
  return g
}

export function clearFixtureCatalog(connection = "default"): void {
  AgentRuntime.root().catalog.instances.delete(connection)
  _resetCatalogQueriesCache()
}
