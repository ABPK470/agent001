/**
 * Mymi DB explorer routes — catalog-backed, zero SQL for structural queries.
 *
 * ALL structural endpoints (overview, schemas, objects, columns, relations,
 * lineage, datamodel, search) are served from the in-memory CatalogGraph
 * that is built once at server startup and cached to disk.  They return
 * in < 5 ms with no database round-trips.
 *
 * The ONE exception is preview — it must read actual table data from SQL.
 *
 * SQL fallback: if the catalog has not loaded yet, structural endpoints
 * return an empty result set rather than erroring.
 */

import { getCatalog, getMssqlConfig, getMssqlPool } from "@agent001/agent"
import type { FastifyInstance } from "fastify"

// ── Helpers ──────────────────────────────────────────────────────

type QS = { Querystring: { db?: string } }

function connName(qs: { db?: string }): string {
  return qs.db ?? "default"
}

function validateIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_\-]*$/.test(name)
}

async function acquirePool(db: string) {
  return getMssqlPool(db)
}

/** Format maxLength into a display type-detail string. */
function fmtTypeDetail(dataType: string, maxLength: number | null): string | null {
  if (maxLength === null) return null
  if (maxLength === -1) return "MAX"
  const dt = dataType.toLowerCase()
  if (dt === "nvarchar" || dt === "nchar") return String(maxLength / 2)
  if (dt === "varchar" || dt === "char" || dt === "binary" || dt === "varbinary") return String(maxLength)
  return null
}

// ── Routes ───────────────────────────────────────────────────────

export function registerMymiRoutes(app: FastifyInstance): void {

  // ── Configured databases ─────────────────────────────────────
  app.get("/api/mymi/databases", async () =>
    getMssqlConfig().map((c) => ({
      name: c.name, server: c.server, database: c.database, writeEnabled: c.writeEnabled,
    })),
  )

  // ── DB-level overview ────────────────────────────────────────
  app.get<QS>("/api/mymi/overview", async (req) => {
    const catalog = getCatalog(connName(req.query))
    if (!catalog) return []

    const bySchema = new Map<string, { tableCount: number; viewCount: number; totalRows: number; totalMb: number }>()
    for (const [, t] of catalog.tables) {
      if (!bySchema.has(t.schema)) bySchema.set(t.schema, { tableCount: 0, viewCount: 0, totalRows: 0, totalMb: 0 })
      const e = bySchema.get(t.schema)!
      if (t.type === "TABLE") {
        e.tableCount++
        e.totalRows += t.rowCount ?? 0
      } else {
        e.viewCount++
        e.totalRows += catalog.viewSourceRows.get(t.qualifiedName) ?? 0
      }
    }
    return [...bySchema.entries()]
      .map(([schema, e]) => ({ schema, ...e }))
      .sort((a, b) => b.totalRows - a.totalRows || a.schema.localeCompare(b.schema))
  })

  // ── Schemas with counts ──────────────────────────────────────
  app.get<QS>("/api/mymi/schemas", async (req) => {
    const catalog = getCatalog(connName(req.query))
    if (!catalog) return []

    const bySchema = new Map<string, { tableCount: number; viewCount: number }>()
    for (const [, t] of catalog.tables) {
      if (!bySchema.has(t.schema)) bySchema.set(t.schema, { tableCount: 0, viewCount: 0 })
      const e = bySchema.get(t.schema)!
      if (t.type === "TABLE") { e.tableCount++ } else { e.viewCount++ }
    }
    return [...bySchema.entries()]
      .map(([name, e]) => ({ name, ...e }))
      .sort((a, b) => a.name.localeCompare(b.name))
  })

  // ── Global search ────────────────────────────────────────────
  // Uses catalog in-memory indexes — no SQL, instant results
  app.get<{ Querystring: { db?: string; q?: string; schemas?: string } }>(
    "/api/mymi/search",
    async (req, reply) => {
      const q = (req.query.q ?? "").trim().toLowerCase()
      const schemaFilter = (req.query.schemas ?? "").split(",").filter(Boolean)
      if (q.length < 2) { reply.code(400); return { error: "Query must be at least 2 characters" } }

      const catalog = getCatalog(connName(req.query))
      if (!catalog) return []

      type SR = {
        schema: string; name: string; type: "table" | "view"
        rowCount: number; matchKind: "object" | "column"
        columnName: string | null; columnType: string | null
      }
      const results: SR[] = []
      const seen = new Set<string>()

      for (const [, t] of catalog.tables) {
        if (schemaFilter.length > 0 && !schemaFilter.includes(t.schema)) continue
        const rowCount = t.rowCount ?? (catalog.viewSourceRows.get(t.qualifiedName) ?? 0)

        if (t.name.toLowerCase().includes(q)) {
          const key = `${t.qualifiedName}:object:`
          if (!seen.has(key)) {
            seen.add(key)
            results.push({ schema: t.schema, name: t.name, type: t.type === "TABLE" ? "table" : "view",
              rowCount, matchKind: "object", columnName: null, columnType: null })
          }
        }

        for (const col of t.columns) {
          if (!col.name.toLowerCase().includes(q)) continue
          const key = `${t.qualifiedName}:column:${col.name}`
          if (!seen.has(key)) {
            seen.add(key)
            results.push({ schema: t.schema, name: t.name, type: t.type === "TABLE" ? "table" : "view",
              rowCount, matchKind: "column", columnName: col.name, columnType: col.dataType })
          }
          break // one column hit per table
        }
      }

      results.sort((a, b) => {
        if (a.matchKind !== b.matchKind) return a.matchKind === "object" ? -1 : 1
        return b.rowCount - a.rowCount
      })
      return results.slice(0, 200)
    },
  )

  // ── Objects in a schema ──────────────────────────────────────
  app.get<QS & { Params: { schema: string } }>(
    "/api/mymi/schema/:schema",
    async (req, reply) => {
      const { schema } = req.params
      if (!validateIdentifier(schema)) { reply.code(400); return { error: "Invalid schema name" } }

      const catalog = getCatalog(connName(req.query))
      if (!catalog) return []

      const results = []
      for (const [, t] of catalog.tables) {
        if (t.schema !== schema) continue
        results.push({
          name:        t.name,
          type:        t.type === "TABLE" ? "table" as const : "view" as const,
          rowCount:    t.rowCount ?? (catalog.viewSourceRows.get(t.qualifiedName) ?? 0),
          sizeMb:      0,
          columnCount: t.columns.length,
        })
      }
      results.sort((a, b) => {
        if (a.type !== b.type) return a.type === "table" ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      return results
    },
  )

  // ── Column definitions ────────────────────────────────────────
  app.get<QS & { Params: { schema: string; table: string } }>(
    "/api/mymi/schema/:schema/table/:table/columns",
    async (req, reply) => {
      const { schema, table } = req.params
      if (!validateIdentifier(schema) || !validateIdentifier(table)) {
        reply.code(400); return { error: "Invalid identifier" }
      }
      const catalog = getCatalog(connName(req.query))
      if (!catalog) return []

      const t = catalog.tables.get(`${schema}.${table}`)
      if (!t) return []

      // Column name → FK info from fkOutgoing
      const fkByCol = new Map<string, { fkSchema: string; fkTable: string; fkColumn: string }>()
      for (const fk of t.fkOutgoing) {
        fkByCol.set(fk.fromColumn, { fkSchema: fk.toSchema, fkTable: fk.toTable, fkColumn: fk.toColumn })
      }

      return t.columns.map((c, i) => {
        const fk = fkByCol.get(c.name)
        return {
          ordinal:     i + 1,
          name:        c.name,
          dataType:    c.dataType,
          typeDetail:  fmtTypeDetail(c.dataType, c.maxLength),
          nullable:    c.nullable,
          identity:    false,
          computed:    false,
          isPk:        c.isPK,
          fkSchema:    fk?.fkSchema ?? null,
          fkTable:     fk?.fkTable  ?? null,
          fkColumn:    fk?.fkColumn ?? null,
          description: null,
        }
      })
    },
  )

  // ── FK relationships ──────────────────────────────────────────
  app.get<QS & { Params: { schema: string; table: string } }>(
    "/api/mymi/schema/:schema/table/:table/relations",
    async (req, reply) => {
      const { schema, table } = req.params
      if (!validateIdentifier(schema) || !validateIdentifier(table)) {
        reply.code(400); return { error: "Invalid identifier" }
      }
      const catalog = getCatalog(connName(req.query))
      if (!catalog) return { outbound: [], inbound: [] }

      const entry = catalog.tables.get(`${schema}.${table}`)
      if (!entry) return { outbound: [], inbound: [] }

      return {
        outbound: entry.fkOutgoing.map((fk) => {
          const ref = catalog.tables.get(`${fk.toSchema}.${fk.toTable}`)
          return {
            constraintName: fk.constraint,
            localColumn:    fk.fromColumn,
            refSchema:      fk.toSchema,
            refTable:       fk.toTable,
            refColumn:      fk.toColumn,
            refRowCount:    ref?.rowCount ?? (catalog.viewSourceRows.get(`${fk.toSchema}.${fk.toTable}`) ?? 0),
          }
        }),
        inbound: entry.fkIncoming.map((fk) => {
          const src = catalog.tables.get(`${fk.fromSchema}.${fk.fromTable}`)
          return {
            constraintName: fk.constraint,
            srcSchema:      fk.fromSchema,
            srcTable:       fk.fromTable,
            srcColumn:      fk.fromColumn,
            localColumn:    fk.toColumn,
            srcRowCount:    src?.rowCount ?? (catalog.viewSourceRows.get(`${fk.fromSchema}.${fk.fromTable}`) ?? 0),
          }
        }),
        implicit: catalog.getImplicitJoins(entry.qualifiedName, 30).map((edge) => ({
          column:   edge.column,
          dataType: edge.dataType,
          tables:   (edge.tables ?? [])
            .filter((qn) => qn !== entry.qualifiedName)
            .map((qn) => ({ qualifiedName: qn, rowCount: catalog.tables.get(qn)?.rowCount ?? null })),
        })),
      }
    },
  )

  // ── Data preview ─────────────────────────────────────────────
  // ONLY endpoint that hits SQL — reads actual table rows
  app.get<{ Params: { schema: string; table: string }; Querystring: { db?: string; limit?: string } }>(
    "/api/mymi/schema/:schema/table/:table/preview",
    async (req, reply) => {
      const db    = connName(req.query)
      const limit = Math.min(Number(req.query.limit ?? 20), 100)
      const { schema, table } = req.params
      if (!validateIdentifier(schema) || !validateIdentifier(table)) {
        reply.code(400); return { error: "Invalid identifier" }
      }
      let conn: Awaited<ReturnType<typeof acquirePool>>
      try { conn = await acquirePool(db) } catch (e) {
        reply.code(400); return { error: String(e) }
      }
      const result = await conn.pool.request().query(
        `SELECT TOP ${limit} * FROM [${schema}].[${table}]`,
      )
      const colMeta = result.recordset.columns as Record<string, { type?: { declaration?: string } }> | undefined
      const columns = colMeta
        ? Object.keys(colMeta).map((col) => ({ name: col, type: colMeta[col]?.type?.declaration ?? "unknown" }))
        : result.recordset.length > 0
          ? Object.keys(result.recordset[0]).map((k) => ({ name: k, type: "unknown" }))
          : []
      return { columns, rows: result.recordset }
    },
  )

  // ── Data lineage ─────────────────────────────────────────────
  // Priority: catalog.lineageMap → etl convention → reverse lineage parents
  app.get<QS & { Params: { schema: string; table: string } }>(
    "/api/mymi/schema/:schema/table/:table/lineage",
    async (req, reply) => {
      const { schema, table } = req.params
      if (!validateIdentifier(schema) || !validateIdentifier(table)) {
        reply.code(400); return { error: "Invalid identifier" }
      }
      const qualifiedName = `${schema}.${table}`

      // 1. catalog.lineageMap — loaded from lineage.json at startup
      const catalog = getCatalog(connName(req.query))
      if (catalog) {
        const entry = catalog.lineageMap.get(qualifiedName)
          ?? catalog.lineageMap.get(qualifiedName.toLowerCase())
          // case-insensitive search
          ?? [...catalog.lineageMap.entries()].find(([k]) => k.toLowerCase() === qualifiedName.toLowerCase())?.[1]
        if (entry) {
          return {
            source: "catalog", object: entry.view,
            description:   entry.description,
            outputColumns: entry.outputColumns ?? [],
            sources: (entry.sources ?? []).map((s) => ({
              qualifiedName: s.qualifiedName, businessArea: s.businessArea ?? null,
              group: s.group ?? null, filter: s.filter ?? null,
            })),
            dimJoins: (entry.dimJoins ?? []).map((d) => ({
              column: d.column, dimTable: d.dimTable,
              dimRows: d.dimRows ?? null, note: d.note ?? null,
            })),
          }
        }
      }

      // 2. ETL mapping convention — no SQL needed
      if (schema === "etl" && table.startsWith("mapping_")) {
        const parts = table.replace(/^mapping_/, "").split("_")
        return {
          source: "convention", object: qualifiedName,
          description: "ETL mapping table generated by the rule engine. Pattern: mapping_{primaryKey}_{targetTable}_{ruleId}",
          convention: { primaryKey: parts[0] ?? null, targetTable: parts.slice(1, -1).join("_") ?? null, ruleId: parts[parts.length - 1] ?? null },
          sources: [], dimJoins: [],
        }
      }

      // 3. Reverse lineage: this object is consumed by other views
      // getLineageParents() scans all lineage entries to find views where this table appears as a source
      const parents = catalog?.getLineageParents(qualifiedName) ?? []
      const concepts = catalog?.getTableConcepts(qualifiedName) ?? []
      if (parents.length > 0 || concepts.length > 0) {
        return {
          source: "parents",
          object: qualifiedName,
          parents: parents.map((p) => ({ view: p.view, businessArea: p.businessArea })),
          concepts: concepts.map((c) => ({
            concept:     c.concept,
            sourceView:  c.sourceView,
            description: c.description,
          })),
        }
      }

      // 4. View SQL definition fallback — if catalog holds the CREATE VIEW SQL, return it so the
      // UI can display the raw definition even when no curated lineage entry exists.
      const tableEntry = catalog?.getTable(qualifiedName)
      if (tableEntry?.viewDefinition) {
        return {
          source:         "viewDefinition",
          object:         qualifiedName,
          viewDefinition: tableEntry.viewDefinition,
          sources:        [],
          dimJoins:       [],
        }
      }

      return { source: "none", object: qualifiedName, sources: [], dimJoins: [] }
    },
  )

  // ── Full data model snapshot ──────────────────────────────────
  // Entire schema graph from catalog — the Data Model tab uses this
  app.get<QS>("/api/mymi/datamodel", async (req) => {
    const catalog = getCatalog(connName(req.query))
    if (!catalog) return { objects: [], relations: [] }

    const objects = []
    for (const [, t] of catalog.tables) {
      objects.push({
        schema:      t.schema,
        name:        t.name,
        isTable:     t.type === "TABLE",
        rowCount:    t.rowCount ?? (catalog.viewSourceRows.get(t.qualifiedName) ?? 0),
        sizeMb:      0,
        columnCount: t.columns.length,
        fkOut:       t.fkOutgoing.length,
        fkIn:        t.fkIncoming.length,
      })
    }

    // Unique FK edges (parent → referenced) from adjacency map
    const relSet = new Set<string>()
    const relations = []
    for (const [, edges] of catalog.adjacency) {
      for (const edge of edges) {
        const k = `${edge.fk.fromSchema}.${edge.fk.fromTable}→${edge.fk.toSchema}.${edge.fk.toTable}`
        if (relSet.has(k)) continue
        relSet.add(k)
        relations.push({
          srcSchema: edge.fk.fromSchema, srcTable: edge.fk.fromTable,
          refSchema: edge.fk.toSchema,   refTable: edge.fk.toTable,
        })
      }
    }

    return { objects, relations }
  })
}
