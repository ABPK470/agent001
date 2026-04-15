/**
 * MSSQL data profiling tool — quick statistical analysis of table data.
 *
 * Gives the agent deep understanding of what's actually IN the data:
 * row counts, null rates, distinct values, min/max, top frequent values,
 * and sample rows. Essential for a data-first platform.
 */

import sql from "mssql";
import type { Tool } from "../types.js";
import { getPool } from "./mssql.js";

// ── Helpers ──────────────────────────────────────────────────────

function escapeIdentifier(name: string): string {
  return `[${name.replace(/\]/g, "]]")}]`
}

function parseTableName(input: string): { schema: string; table: string } | null {
  const parts = input.split(".")
  if (parts.length === 2) return { schema: parts[0], table: parts[1] }
  return null
}

// ── The tool ─────────────────────────────────────────────────────

export const profileDataTool: Tool = {
  name: "profile_data",
  description:
    "Profile a database table — get statistical analysis of actual data content. " +
    "Returns: row count, per-column null rate, distinct count, min/max values, and top frequent values. " +
    "Use this to UNDERSTAND the data before writing analytical queries — know the cardinality, " +
    "spot NULL-heavy columns, find common values, and understand data distribution. " +
    "Always provide schema-qualified table name (e.g. 'dim.Client', 'fact.AfricaFlex'). " +
    "For large tables: specify columns to profile (avoids scanning the entire table).",
  parameters: {
    type: "object",
    properties: {
      table: {
        type: "string",
        description:
          "Schema-qualified table name to profile (e.g. 'core.Dataset', 'dim.Client'). Required.",
      },
      columns: {
        type: "array",
        items: { type: "string" },
        description:
          "Specific columns to profile (optional). If omitted, profiles all columns. " +
          "Recommended for large tables — specify only the columns you need.",
      },
      sample: {
        type: "number",
        description: "Number of sample rows to return (default: 5, max: 20).",
      },
      topN: {
        type: "number",
        description: "Number of top frequent values to show per column (default: 5, max: 10).",
      },
      connection: {
        type: "string",
        description: "Named database connection to use. Omit for default.",
      },
    },
    required: ["table"],
  },

  async execute(args) {
    const parsed = parseTableName(String(args.table).trim())
    if (!parsed) {
      return "Error: table must be schema-qualified (e.g. 'dim.Client'). Use explore_mssql_schema to find table names."
    }
    const { schema, table } = parsed
    const sampleCount = Math.min(Math.max(Number(args.sample) || 5, 1), 20)
    const topN = Math.min(Math.max(Number(args.topN) || 5, 1), 10)
    const connName = args.connection ? String(args.connection).trim() : undefined

    let pool: sql.ConnectionPool
    try {
      const result = await getPool(connName)
      pool = result.pool
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }

    try {
      const fullTable = `${escapeIdentifier(schema)}.${escapeIdentifier(table)}`

      // Step 1: Get columns and their types
      const colRequest = pool.request()
      colRequest.input("schema", sql.NVarChar, schema)
      colRequest.input("table", sql.NVarChar, table)
      const colResult = await colRequest.query(`
        SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE
        FROM INFORMATION_SCHEMA.COLUMNS c
        WHERE c.TABLE_SCHEMA = @schema AND c.TABLE_NAME = @table
        ORDER BY c.ORDINAL_POSITION
      `)

      if (!colResult.recordset.length) {
        return `No columns found for ${schema}.${table}. Check the table name with explore_mssql_schema.`
      }

      // Filter to requested columns if specified
      let targetColumns = colResult.recordset as Array<{ COLUMN_NAME: string; DATA_TYPE: string; IS_NULLABLE: string }>
      if (args.columns && Array.isArray(args.columns)) {
        const requested = new Set((args.columns as string[]).map((c) => c.toLowerCase()))
        targetColumns = targetColumns.filter((c) => requested.has(c.COLUMN_NAME.toLowerCase()))
        if (targetColumns.length === 0) {
          return `None of the specified columns found. Available: ${colResult.recordset.map((c: Record<string, string>) => c.COLUMN_NAME).join(", ")}`
        }
      }

      // Cap columns to avoid huge queries on wide tables
      const maxCols = 15
      const truncatedCols = targetColumns.length > maxCols
      if (truncatedCols) targetColumns = targetColumns.slice(0, maxCols)

      // Step 2: Row count
      const countResult = await pool.request().query(
        `SELECT COUNT_BIG(*) AS row_count FROM ${fullTable}`,
      )
      const rowCount = countResult.recordset[0].row_count as number

      // Step 3: Per-column statistics (single query for efficiency)
      const statParts: string[] = []
      for (const col of targetColumns) {
        const escaped = escapeIdentifier(col.COLUMN_NAME)
        statParts.push(
          `SUM(CASE WHEN ${escaped} IS NULL THEN 1 ELSE 0 END) AS [null_${col.COLUMN_NAME}]`,
          `COUNT(DISTINCT ${escaped}) AS [distinct_${col.COLUMN_NAME}]`,
        )
        // Min/max for numeric, date, and string types (skip binary/image/xml)
        const canMinMax = !["image", "text", "ntext", "xml", "geography", "geometry", "hierarchyid", "sql_variant"].includes(col.DATA_TYPE.toLowerCase())
        if (canMinMax) {
          statParts.push(
            `MIN(${escaped}) AS [min_${col.COLUMN_NAME}]`,
            `MAX(${escaped}) AS [max_${col.COLUMN_NAME}]`,
          )
        }
      }

      let statsRecord: Record<string, unknown> = {}
      if (statParts.length > 0 && rowCount > 0) {
        const statsResult = await pool.request().query(
          `SELECT ${statParts.join(", ")} FROM ${fullTable}`,
        )
        statsRecord = statsResult.recordset[0] as Record<string, unknown>
      }

      // Step 4: Build output
      const sections: string[] = [
        `Profile for ${schema}.${table}:`,
        `Total rows: ${rowCount.toLocaleString()}`,
        "",
      ]

      for (const col of targetColumns) {
        const nullCount = (statsRecord[`null_${col.COLUMN_NAME}`] as number) ?? 0
        const distinctCount = (statsRecord[`distinct_${col.COLUMN_NAME}`] as number) ?? 0
        const nullPct = rowCount > 0 ? ((nullCount / rowCount) * 100).toFixed(1) : "0.0"
        const minVal = statsRecord[`min_${col.COLUMN_NAME}`]
        const maxVal = statsRecord[`max_${col.COLUMN_NAME}`]

        const parts = [
          `  ${col.COLUMN_NAME} (${col.DATA_TYPE}, ${col.IS_NULLABLE === "YES" ? "nullable" : "NOT NULL"})`,
          `    Distinct: ${distinctCount.toLocaleString()} | Nulls: ${nullCount.toLocaleString()} (${nullPct}%)`,
        ]
        if (minVal !== undefined) {
          const minStr = minVal instanceof Date ? minVal.toISOString() : String(minVal)
          const maxStr = maxVal instanceof Date ? (maxVal as Date).toISOString() : String(maxVal)
          parts.push(`    Min: ${minStr} | Max: ${maxStr}`)
        }
        sections.push(parts.join("\n"))
      }

      if (truncatedCols) {
        sections.push(`\n(Showing first ${maxCols} columns — specify 'columns' to profile specific ones)`)
      }

      // Step 5: Top N frequent values for each column (limit to first 5 columns to avoid too many queries)
      const topNCols = targetColumns.slice(0, 5)
      if (rowCount > 0 && topNCols.length > 0) {
        sections.push("\nTop frequent values:")
        for (const col of topNCols) {
          const escaped = escapeIdentifier(col.COLUMN_NAME)
          try {
            const topResult = await pool.request().query(
              `SELECT TOP ${topN} ${escaped} AS val, COUNT(*) AS cnt ` +
              `FROM ${fullTable} WHERE ${escaped} IS NOT NULL ` +
              `GROUP BY ${escaped} ORDER BY COUNT(*) DESC`,
            )
            if (topResult.recordset.length > 0) {
              sections.push(`  ${col.COLUMN_NAME}:`)
              for (const r of topResult.recordset) {
                const v = r.val instanceof Date ? r.val.toISOString() : String(r.val)
                sections.push(`    ${v} (${(r.cnt as number).toLocaleString()})`)
              }
            }
          } catch {
            // Some column types can't be grouped — skip silently
          }
        }
      }

      // Step 6: Sample rows
      if (rowCount > 0) {
        const sampleCols = targetColumns.slice(0, 8).map((c) => escapeIdentifier(c.COLUMN_NAME)).join(", ")
        const sampleResult = await pool.request().query(
          `SELECT TOP ${sampleCount} ${sampleCols} FROM ${fullTable}`,
        )
        if (sampleResult.recordset.length > 0) {
          sections.push(`\nSample rows (${sampleResult.recordset.length}):`)
          const cols = Object.keys(sampleResult.recordset[0] as Record<string, unknown>)
          sections.push(`  ${cols.join(" | ")}`)
          sections.push(`  ${cols.map((c) => "-".repeat(Math.min(c.length, 15))).join("-+-")}`)
          for (const row of sampleResult.recordset) {
            const r = row as Record<string, unknown>
            const vals = cols.map((c) => {
              const v = r[c]
              if (v === null || v === undefined) return "NULL"
              if (v instanceof Date) return v.toISOString()
              const s = String(v)
              return s.length > 30 ? s.slice(0, 27) + "..." : s
            })
            sections.push(`  ${vals.join(" | ")}`)
          }
        }
      }

      return sections.join("\n")
    } catch (err) {
      return `SQL Error: ${err instanceof Error ? err.message : String(err)}`
    }
  },
}
