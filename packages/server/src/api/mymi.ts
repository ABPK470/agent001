/**
 * Mymi DB explorer transport routes.
 */

import { getCatalog, getMssqlConfig, getPool, type AgentHost } from "@mia/agent"
import type { FastifyInstance } from "fastify"

type QS = { Querystring: { db?: string } }

function connName(qs: { db?: string }): string {
	return qs.db ?? "default"
}

function validateIdentifier(name: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_\-]*$/.test(name)
}

function fmtTypeDetail(dataType: string, maxLength: number | null): string | null {
	if (maxLength === null) return null
	if (maxLength === -1) return "MAX"
	const dt = dataType.toLowerCase()
	if (dt === "nvarchar" || dt === "nchar") return String(maxLength / 2)
	if (dt === "varchar" || dt === "char" || dt === "binary" || dt === "varbinary") return String(maxLength)
	return null
}

export function registerMymiRoutes(app: FastifyInstance, host: AgentHost): void {
	async function acquirePoolH(db: string) {
		return getPool(host, db)
	}

	app.get("/api/mymi/databases", async () =>
		getMssqlConfig(host).map((config) => ({
			name: config.name,
			server: config.server,
			database: config.database,
			writeEnabled: config.writeEnabled,
		})),
	)

	app.get<QS>("/api/mymi/overview", async (req) => {
		const catalog = getCatalog(host, connName(req.query))
		if (!catalog) return []
		const bySchema = new Map<string, { tableCount: number; viewCount: number; totalRows: number; totalMb: number }>()
		for (const [, table] of catalog.tables) {
			if (!bySchema.has(table.schema)) bySchema.set(table.schema, { tableCount: 0, viewCount: 0, totalRows: 0, totalMb: 0 })
			const entry = bySchema.get(table.schema)!
			if (table.type === "TABLE") {
				entry.tableCount++
				entry.totalRows += table.rowCount ?? 0
			} else {
				entry.viewCount++
				entry.totalRows += catalog.viewSourceRows.get(table.qualifiedName) ?? 0
			}
		}
		return [...bySchema.entries()].map(([schema, entry]) => ({ schema, ...entry })).sort((a, b) => b.totalRows - a.totalRows || a.schema.localeCompare(b.schema))
	})

	app.get<QS>("/api/mymi/schemas", async (req) => {
		const catalog = getCatalog(host, connName(req.query))
		if (!catalog) return []
		const bySchema = new Map<string, { tableCount: number; viewCount: number }>()
		for (const [, table] of catalog.tables) {
			if (!bySchema.has(table.schema)) bySchema.set(table.schema, { tableCount: 0, viewCount: 0 })
			const entry = bySchema.get(table.schema)!
			if (table.type === "TABLE") { entry.tableCount++ } else { entry.viewCount++ }
		}
		return [...bySchema.entries()].map(([name, entry]) => ({ name, ...entry })).sort((a, b) => a.name.localeCompare(b.name))
	})

	app.get<{ Querystring: { db?: string; q?: string; schemas?: string } }>("/api/mymi/search", async (req, reply) => {
		const q = (req.query.q ?? "").trim().toLowerCase()
		const schemaFilter = (req.query.schemas ?? "").split(",").filter(Boolean)
		if (q.length < 2) { reply.code(400); return { error: "Query must be at least 2 characters" } }
		const catalog = getCatalog(host, connName(req.query))
		if (!catalog) return []

		type SearchRow = { schema: string; name: string; type: "table" | "view"; rowCount: number; matchKind: "object" | "column"; columnName: string | null; columnType: string | null }
		const results: SearchRow[] = []
		const seen = new Set<string>()

		for (const [, table] of catalog.tables) {
			if (schemaFilter.length > 0 && !schemaFilter.includes(table.schema)) continue
			const rowCount = table.rowCount ?? (catalog.viewSourceRows.get(table.qualifiedName) ?? 0)
			if (table.name.toLowerCase().includes(q)) {
				const key = `${table.qualifiedName}:object:`
				if (!seen.has(key)) {
					seen.add(key)
					results.push({ schema: table.schema, name: table.name, type: table.type === "TABLE" ? "table" : "view", rowCount, matchKind: "object", columnName: null, columnType: null })
				}
			}
			for (const column of table.columns) {
				if (!column.name.toLowerCase().includes(q)) continue
				const key = `${table.qualifiedName}:column:${column.name}`
				if (!seen.has(key)) {
					seen.add(key)
					results.push({ schema: table.schema, name: table.name, type: table.type === "TABLE" ? "table" : "view", rowCount, matchKind: "column", columnName: column.name, columnType: column.dataType })
				}
				break
			}
		}
		results.sort((a, b) => (a.matchKind !== b.matchKind ? (a.matchKind === "object" ? -1 : 1) : b.rowCount - a.rowCount))
		return results.slice(0, 200)
	})

	app.get<QS & { Params: { schema: string } }>("/api/mymi/schema/:schema", async (req, reply) => {
		const { schema } = req.params
		if (!validateIdentifier(schema)) { reply.code(400); return { error: "Invalid schema name" } }
		const catalog = getCatalog(host, connName(req.query))
		if (!catalog) return []
		const results = []
		for (const [, table] of catalog.tables) {
			if (table.schema !== schema) continue
			results.push({ name: table.name, type: table.type === "TABLE" ? "table" as const : "view" as const, rowCount: table.rowCount ?? (catalog.viewSourceRows.get(table.qualifiedName) ?? 0), sizeMb: 0, columnCount: table.columns.length })
		}
		results.sort((a, b) => (a.type !== b.type ? (a.type === "table" ? -1 : 1) : a.name.localeCompare(b.name)))
		return results
	})

	app.get<QS & { Params: { schema: string; table: string } }>("/api/mymi/schema/:schema/table/:table/columns", async (req, reply) => {
		const { schema, table } = req.params
		if (!validateIdentifier(schema) || !validateIdentifier(table)) { reply.code(400); return { error: "Invalid identifier" } }
		const catalog = getCatalog(host, connName(req.query))
		if (!catalog) return []
		const entry = catalog.tables.get(`${schema}.${table}`)
		if (!entry) return []
		const fkByCol = new Map<string, { fkSchema: string; fkTable: string; fkColumn: string }>()
		for (const fk of entry.fkOutgoing) fkByCol.set(fk.fromColumn, { fkSchema: fk.toSchema, fkTable: fk.toTable, fkColumn: fk.toColumn })
		return entry.columns.map((column, index) => {
			const fk = fkByCol.get(column.name)
			return {
				ordinal: index + 1,
				name: column.name,
				dataType: column.dataType,
				typeDetail: fmtTypeDetail(column.dataType, column.maxLength),
				nullable: column.nullable,
				identity: false,
				computed: false,
				isPk: column.isPK,
				fkSchema: fk?.fkSchema ?? null,
				fkTable: fk?.fkTable ?? null,
				fkColumn: fk?.fkColumn ?? null,
				description: null,
			}
		})
	})

	app.get<QS & { Params: { schema: string; table: string } }>("/api/mymi/schema/:schema/table/:table/relations", async (req, reply) => {
		const { schema, table } = req.params
		if (!validateIdentifier(schema) || !validateIdentifier(table)) { reply.code(400); return { error: "Invalid identifier" } }
		const catalog = getCatalog(host, connName(req.query))
		if (!catalog) return { outbound: [], inbound: [] }
		const entry = catalog.tables.get(`${schema}.${table}`)
		if (!entry) return { outbound: [], inbound: [] }
		return {
			outbound: entry.fkOutgoing.map((fk) => {
				const ref = catalog.tables.get(`${fk.toSchema}.${fk.toTable}`)
				return { constraintName: fk.constraint, localColumn: fk.fromColumn, refSchema: fk.toSchema, refTable: fk.toTable, refColumn: fk.toColumn, refRowCount: ref?.rowCount ?? (catalog.viewSourceRows.get(`${fk.toSchema}.${fk.toTable}`) ?? 0) }
			}),
			inbound: entry.fkIncoming.map((fk) => {
				const src = catalog.tables.get(`${fk.fromSchema}.${fk.fromTable}`)
				return { constraintName: fk.constraint, srcSchema: fk.fromSchema, srcTable: fk.fromTable, srcColumn: fk.fromColumn, localColumn: fk.toColumn, srcRowCount: src?.rowCount ?? (catalog.viewSourceRows.get(`${fk.fromSchema}.${fk.fromTable}`) ?? 0) }
			}),
			implicit: catalog.getImplicitJoins(entry.qualifiedName, 30).map((edge) => ({
				column: edge.column,
				dataType: edge.dataType,
				tables: (edge.tables ?? []).filter((qn) => qn !== entry.qualifiedName).map((qn) => ({ qualifiedName: qn, rowCount: catalog.tables.get(qn)?.rowCount ?? null })),
			})),
		}
	})

	app.get<{ Params: { schema: string; table: string }; Querystring: { db?: string; limit?: string } }>("/api/mymi/schema/:schema/table/:table/preview", async (req, reply) => {
		const db = connName(req.query)
		const limit = Math.min(Number(req.query.limit ?? 20), 100)
		const { schema, table } = req.params
		if (!validateIdentifier(schema) || !validateIdentifier(table)) { reply.code(400); return { error: "Invalid identifier" } }
		let conn: Awaited<ReturnType<typeof acquirePoolH>>
		try { conn = await acquirePoolH(db) } catch (error) { reply.code(400); return { error: String(error) } }
		const result = await conn.pool.request().query(`SELECT TOP ${limit} * FROM [${schema}].[${table}]`)
		const colMeta = result.recordset.columns as Record<string, { type?: { declaration?: string } }> | undefined
		const columns = colMeta
			? Object.keys(colMeta).map((col) => ({ name: col, type: colMeta[col]?.type?.declaration ?? "unknown" }))
			: result.recordset.length > 0
				? Object.keys(result.recordset[0]).map((key) => ({ name: key, type: "unknown" }))
				: []
		return { columns, rows: result.recordset }
	})

	app.get<QS>("/api/mymi/datamodel", async (req) => {
		const catalog = getCatalog(host, connName(req.query))
		if (!catalog) return { objects: [], relations: [] }
		const objects = []
		for (const [, table] of catalog.tables) {
			objects.push({ schema: table.schema, name: table.name, isTable: table.type === "TABLE", rowCount: table.rowCount ?? (catalog.viewSourceRows.get(table.qualifiedName) ?? 0), sizeMb: 0, columnCount: table.columns.length, fkOut: table.fkOutgoing.length, fkIn: table.fkIncoming.length })
		}
		const relSet = new Set<string>()
		const relations = []
		for (const [, edges] of catalog.adjacency) {
			for (const edge of edges) {
				const k = `${edge.fk.fromSchema}.${edge.fk.fromTable}→${edge.fk.toSchema}.${edge.fk.toTable}`
				if (relSet.has(k)) continue
				relSet.add(k)
				relations.push({ srcSchema: edge.fk.fromSchema, srcTable: edge.fk.fromTable, refSchema: edge.fk.toSchema, refTable: edge.fk.toTable })
			}
		}
		return { objects, relations }
	})
}
