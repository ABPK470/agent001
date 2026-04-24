import sql from "mssql"
import type { Tool } from "../../types.js"
import { getMssqlKillSignal, getPool } from "./connection.js"
import { formatResults } from "./formatter.js"
import { validateQuery } from "./validation.js"

// ── The tool ─────────────────────────────────────────────────────

export const mssqlTool: Tool = {
  name: "query_mssql",
  description:
    "Execute a T-SQL query against Microsoft SQL Server. Read-only by default (SELECT/WITH only). " +
    "Use this for INSPECTION and ANALYSIS — counting rows, computing aggregates, looking at a sample. " +
    "DO NOT use this when the user wants to EXPORT or SAVE many rows to a file: " +
    "the result is truncated at 1000 rows / 50KB, and copying that truncated text into write_file " +
    "produces a broken file. For exports, call export_query_to_file instead — it streams the full " +
    "result set directly to disk and returns only a 20-row preview. " +
    "CRITICAL: NEVER guess column names. Before writing ANY query, call explore_mssql_schema first " +
    "to get the exact column names and types for each table you plan to query. " +
    "Always use schema-qualified table names (e.g. agent.PipelineRun, not just PipelineRun). " +
    "Always SELECT only the columns you actually need — never SELECT * on tables with wide JSON/blob columns " +
    "(e.g. core.Dataset has a 50KB+ controlFlow column). " +
    "When data spans multiple tables/views, explore EACH table first, then JOIN them. " +
    "For large tables (>1M rows), always include WHERE clauses with date filters and use TOP. " +
    "Returns results as plain text table format.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The SQL query to execute. Must be a valid T-SQL statement.",
      },
      connection: {
        type: "string",
        description: "Named database connection to use (configured at startup). Omit to use the default connection.",
      },
      database: {
        type: "string",
        description: "Optional: switch to a different database before running the query. Equivalent to USE [database].",
      },
    },
    required: ["query"],
  },

  async execute(args) {
    const query = String(args.query).trim()
    if (!query) return "Error: query cannot be empty."

    const connectionName = args.connection ? String(args.connection).trim() : "default"

    let pool: sql.ConnectionPool
    let writeEnabled: boolean
    try {
      const result = await getPool(connectionName)
      pool = result.pool
      writeEnabled = result.entry.writeEnabled
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }

    // Validate before executing
    const error = validateQuery(query, writeEnabled)
    if (error) return error

    try {
      // Optional database switch
      const db = args.database ? String(args.database).trim() : null
      if (db) {
        // Validate database name (alphanumeric, underscores, hyphens only)
        if (!/^[\w-]+$/.test(db)) {
          return "Error: invalid database name."
        }
      }

      const request = pool.request()
      const killSignal = getMssqlKillSignal()

      // If a kill signal fires while the query is running, cancel it immediately
      const onKill = (): void => { request.cancel() }
      if (killSignal) {
        if (killSignal.aborted) return "Error: Tool execution cancelled"
        killSignal.addEventListener("abort", onKill, { once: true })
      }

      // If a specific database is requested, prefix with USE
      const fullQuery = db ? `USE [${db}];\n${query}` : query

      try {
        const result = await request.query(fullQuery)
        return formatResults(result.recordsets as sql.IRecordSet<unknown>[], result.rowsAffected)
      } finally {
        killSignal?.removeEventListener("abort", onKill)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `SQL Error: ${msg}`
    }
  },
}

// ── Schema explorer (convenience tool) ───────────────────────────

export const mssqlSchemaTool: Tool = {
  name: "explore_mssql_schema",
  description:
    "Explore the MSSQL database schema — list tables/views in a schema, or get exact column names and types for a table. " +
    "ALWAYS call this BEFORE writing any query_mssql query. This is mandatory, not optional. " +
    "Step 1: Call with schema='agent' to list tables in that schema. " +
    "Step 2: Call with table='agent.PipelineRun' to get exact columns. " +
    "Step 3: Only THEN write your query_mssql using the discovered column names. " +
    "Never assume column names — they are often different from what you'd expect.",
  parameters: {
    type: "object",
    properties: {
      schema: {
        type: "string",
        description: "Filter by schema name (e.g., 'agent', 'core', 'publish', 'dim', 'fact'). Lists all tables/views in that schema.",
      },
      table: {
        type: "string",
        description: "Get detailed column info for a specific table. Use schema prefix for accuracy (e.g., 'agent.PipelineRun', 'core.Dataset', 'fact.AfricaFlex'). Without prefix, searches all schemas.",
      },
      search: {
        type: "string",
        description: "Search for tables/views by name pattern across all schemas. Uses SQL LIKE with wildcards added automatically. E.g., search='Revenue' finds all tables/views containing 'Revenue' in any schema. search='Pipeline' finds agent.PipelineRun, core.Pipeline, etc.",
      },
      connection: {
        type: "string",
        description: "Named database connection to use (configured at startup). Omit to use the default connection.",
      },
    },
    required: [],
  },

  async execute(args) {
    const connectionName = args.connection ? String(args.connection).trim() : "default"

    let pool: sql.ConnectionPool
    try {
      const result = await getPool(connectionName)
      pool = result.pool
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }

    try {
      const request = pool.request()
      const killSignal = getMssqlKillSignal()

      // If a kill signal fires while the query is running, cancel it immediately
      const onKill = (): void => { request.cancel() }
      if (killSignal) {
        if (killSignal.aborted) return "Error: Tool execution cancelled"
        killSignal.addEventListener("abort", onKill, { once: true })
      }

      try {
        if (args.table) {
          const tableName = String(args.table)
          // Parameterize the table lookup
          const parts = tableName.split(".")
          const schema = parts.length > 1 ? parts[0] : null
          const table = parts.length > 1 ? parts[1] : parts[0]

          request.input("table", sql.NVarChar, table)
          if (schema) {
            request.input("schema", sql.NVarChar, schema)
          }

          const result = await request.query(`
            SELECT
              c.TABLE_SCHEMA,
              c.COLUMN_NAME,
              c.DATA_TYPE,
              c.CHARACTER_MAXIMUM_LENGTH,
              c.IS_NULLABLE,
              c.COLUMN_DEFAULT,
              CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 'YES' ELSE 'NO' END AS IS_PRIMARY_KEY,
              CASE WHEN fk.COLUMN_NAME IS NOT NULL THEN fk.REFERENCED_TABLE ELSE NULL END AS FK_REFERENCES
            FROM INFORMATION_SCHEMA.COLUMNS c
            LEFT JOIN (
              SELECT ku.COLUMN_NAME, ku.TABLE_SCHEMA, ku.TABLE_NAME
              FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
              JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
                ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
              WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
            ) pk ON pk.TABLE_SCHEMA = c.TABLE_SCHEMA AND pk.TABLE_NAME = c.TABLE_NAME AND pk.COLUMN_NAME = c.COLUMN_NAME
            LEFT JOIN (
              SELECT
                cu.COLUMN_NAME, cu.TABLE_SCHEMA, cu.TABLE_NAME,
                ku2.TABLE_SCHEMA + '.' + ku2.TABLE_NAME AS REFERENCED_TABLE
              FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
              JOIN INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE cu ON rc.CONSTRAINT_NAME = cu.CONSTRAINT_NAME
              JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku2 ON rc.UNIQUE_CONSTRAINT_NAME = ku2.CONSTRAINT_NAME
            ) fk ON fk.TABLE_SCHEMA = c.TABLE_SCHEMA AND fk.TABLE_NAME = c.TABLE_NAME AND fk.COLUMN_NAME = c.COLUMN_NAME
            WHERE ${schema ? "c.TABLE_SCHEMA = @schema AND" : ""} c.TABLE_NAME = @table
            ORDER BY c.TABLE_SCHEMA, c.ORDINAL_POSITION
          `)

          if (!result.recordset.length) return `No columns found for ${tableName}. Try with schema prefix (e.g. 'agent.${table}', 'core.${table}').`
          const label = schema ? `${schema}.${table}` : result.recordset[0].TABLE_SCHEMA + "." + table
          return `Columns for ${label}:\n` +
            formatResults(result.recordsets as sql.IRecordSet<unknown>[], result.rowsAffected)
        }

        // Search for tables/views by name pattern
        if (args.search) {
          const pattern = `%${String(args.search)}%`
          request.input("pattern", sql.NVarChar, pattern)

          const result = await request.query(`
            SELECT
              t.TABLE_SCHEMA,
              t.TABLE_NAME,
              t.TABLE_TYPE,
              (SELECT SUM(p.rows) FROM sys.partitions p
               JOIN sys.tables st ON p.object_id = st.object_id
               JOIN sys.schemas s ON st.schema_id = s.schema_id
               WHERE s.name = t.TABLE_SCHEMA AND st.name = t.TABLE_NAME AND p.index_id IN (0,1)
              ) AS ROW_COUNT
            FROM INFORMATION_SCHEMA.TABLES t
            WHERE t.TABLE_NAME LIKE @pattern
            ORDER BY t.TABLE_SCHEMA, t.TABLE_TYPE, t.TABLE_NAME
          `)

          if (!result.recordset.length) return `No tables/views found matching '${String(args.search)}'. Try a different keyword.`
          return `Tables/views matching '${String(args.search)}':\n` +
            formatResults(result.recordsets as sql.IRecordSet<unknown>[], result.rowsAffected)
        }

        // List all tables/views
        const schemaFilter = args.schema ? String(args.schema) : null
        if (schemaFilter) {
          request.input("schema", sql.NVarChar, schemaFilter)
        }

        const result = await request.query(`
          SELECT
            t.TABLE_SCHEMA,
            t.TABLE_NAME,
            t.TABLE_TYPE,
            (SELECT SUM(p.rows) FROM sys.partitions p
             JOIN sys.tables st ON p.object_id = st.object_id
             JOIN sys.schemas s ON st.schema_id = s.schema_id
             WHERE s.name = t.TABLE_SCHEMA AND st.name = t.TABLE_NAME AND p.index_id IN (0,1)
            ) AS ROW_COUNT
          FROM INFORMATION_SCHEMA.TABLES t
          ${schemaFilter ? "WHERE t.TABLE_SCHEMA = @schema" : ""}
          ORDER BY t.TABLE_SCHEMA, t.TABLE_TYPE, t.TABLE_NAME
        `)

        if (!result.recordset.length) return "No tables found."
        return formatResults(result.recordsets as sql.IRecordSet<unknown>[], result.rowsAffected)
      } finally {
        killSignal?.removeEventListener("abort", onKill)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `SQL Error: ${msg}`
    }
  },
}
