import sql from "mssql"
import { currentRuntime } from "../../agent-runtime.js"
import type { Tool } from "../../types.js"
import { fingerprintForQname, persistToCache, tryServeFromCache } from "../_tool-cache.js"
import { getMssqlKillSignal, getPool } from "./connection.js"
import { detectDimJoinNullRot, renderDimJoinNullBanner } from "./dim-join-quality.js"
import { decorateMssqlError, enrichInvalidColumnError } from "./error-hints.js"
import { formatResults } from "./formatter.js"
import { emitMssqlQualityTrace } from "./trace.js"
import { getQueryWarnings, validateQueryDetailed } from "./validation.js"

// ── The tool ─────────────────────────────────────────────────────

export const mssqlTool: Tool = {
  name: "query_mssql",
  description:
    "Execute a T-SQL query against Microsoft SQL Server (T-SQL only — no QUALIFY, LIMIT, ILIKE, ::, DATE_TRUNC; use TOP / OFFSET-FETCH / LIKE / CAST / DATEADD). " +
    "Read-only on existing tables/views/indexes. You ARE allowed to CREATE / INSERT / UPDATE / DELETE / DROP / TRUNCATE / SELECT INTO / CREATE INDEX on local #temp tables (single-#, never ##) — use them to stage micro-ETL slices for billion-row joins. " +
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
        description:
          "Named server/pool to connect to (e.g. 'prod', 'uat'). " +
          "This selects WHICH pre-configured SQL Server instance to use — it is NOT passed to SQL. " +
          "Omit to use the default connection (stated in your system prompt). " +
          "⚠️ NEVER pass an environment name here as the 'database' parameter — that generates " +
          "USE [name] SQL which will fail with 'Database does not exist'.",
      },
      database: {
        type: "string",
        description:
          "Optional: switch catalog database on the CURRENT server before running the query (generates USE [database]). " +
          "Use this ONLY when the target catalog has a different name than the connection's default database " +
          "(e.g. switching from 'mymi' to 'master' on the same server). " +
          "⚠️ Do NOT pass an environment/connection name here (e.g. 'dev', 'uat', 'prod') — those are connection names, not database names.",
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
    const validation = validateQueryDetailed(query, writeEnabled)
    if (!validation.ok) {
      emitMssqlQualityTrace({
        toolMode: "query",
        phase: "blocked",
        query,
        connection: connectionName,
        database: args.database ? String(args.database).trim() : null,
        validation,
      })
      // Gap 2: route the doctrine lesson (if any) to the per-run memory
      // writer so the rationale survives beyond this turn. Fire-and-forget
      // because the writer is synchronous and a failure (null hook, dedup
      // rejection) must not mask the original block error.
      const lesson = validation.lesson
      if (lesson) {
        try {
          currentRuntime().memory.writeNote?.(lesson)
        } catch {
          // Memory write failures must never block the validator response.
        }
      }
      return validation.error ?? "Query blocked"
    }

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
      const startedAt = Date.now()

      try {
        const result = await request.query(fullQuery)
        const rowCount = result.recordsets.reduce((sum, recordset) => sum + recordset.length, 0)
        emitMssqlQualityTrace({
          toolMode: "query",
          phase: "executed",
          query,
          connection: connectionName,
          database: db,
          validation,
          durationMs: Date.now() - startedAt,
          rowCount,
        })
        const body = formatResults(result.recordsets as sql.IRecordSet<unknown>[], result.rowsAffected)
        const warn = getQueryWarnings(query)
        // Phase 6: dim-join NULL rot heuristic. Scan the first recordset's
        // *Name/*Description columns; if ≥ 50% of rows are NULL, prepend a
        // join-key warning so the agent re-verifies the join before trusting
        // the row labels.
        const firstSet = (result.recordsets[0] ?? []) as ReadonlyArray<Record<string, unknown>>
        const dimBanner = renderDimJoinNullBanner(detectDimJoinNullRot(firstSet))
        const banners = [dimBanner, warn].filter((s): s is string => !!s).join("\n")
        return banners ? `${banners}\n${body}` : body
      } finally {
        killSignal?.removeEventListener("abort", onKill)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitMssqlQualityTrace({
        toolMode: "query",
        phase: "failed",
        query,
        connection: connectionName,
        database: args.database ? String(args.database).trim() : null,
        validation,
        error: msg,
      })
      // Fix #3 (2026-05-23): for `Invalid column name 'X'`, append the actual
      // FROM/JOIN tables' columns ranked by similarity to X. Decoration runs
      // *after* so the generic "stop guessing" lesson trails the concrete map.
      const enriched = enrichInvalidColumnError(msg, query, connectionName)
      return `SQL Error: ${decorateMssqlError(enriched)}`
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

          // ── Gap 1: cache check before hitting MSSQL ───────────────
          //
          // explore_mssql_schema(table='schema.X') is the single most-
          // repeated discovery call across runs (trace evidence: same
          // table re-explored on every memory-recalled goal). When the
          // table is schema-qualified we can build a catalog fingerprint
          // and consult `tool_knowledge` exactly like profile_data does.
          //
          // Cross-serve: if our own cache misses, try the profile_data
          // fast cache for the same qname — its payload includes the
          // column list verbatim, so we can hand it back with a tiny
          // banner. This makes the FIRST run's profile_data() also
          // satisfy the SECOND run's explore_mssql_schema(). Tables
          // explored without a schema prefix or not in the catalog
          // fall through to the live path unchanged.
          if (schema) {
            const qn = `${schema}.${table}`
            const fp = fingerprintForQname(qn, connectionName)
            const own = tryServeFromCache("explore_mssql_schema", qn, "columns", connectionName, fp)
            if (own !== null) return own
            const cross = tryServeFromCache("profile_data", qn, "fast", connectionName, fp)
            if (cross !== null) {
              return [
                `[explore_mssql_schema cross-served from profile_data(fast) cache — payload includes columns]`,
                cross,
              ].join("\n")
            }
          }

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
          let payload = `Columns for ${label}:\n` +
            formatResults(result.recordsets as sql.IRecordSet<unknown>[], result.rowsAffected)

          // ── Surrogate-key value ranges ──────────────────────────
          //
          // Root-cause fix: a recurring class of LLM bug is to treat
          // a numeric surrogate key (e.g. dim.month.pkMonth) as if it
          // encoded a meaningful business value (YYYYMM). The model
          // sees `pkMonth (int, NOT NULL)` and writes
          // `WHERE pkMonth = 202504`. The validator passes — int = int —
          // but the table only carries pkMonth values in roughly [1..600],
          // so the query silently returns zero rows.
          //
          // Closing this gap at the discovery layer: for columns whose
          // names match the surrogate-key shape (pk*, fk*, *Id, *Key,
          // *_id, *_key, *Sk, *_sk) we issue a best-effort lookup
          // against sys.dm_db_stats_histogram and append a tight
          // "Value ranges (surrogate keys):" section to the payload.
          // The model then sees `pkMonth: 1..612` and cannot confuse
          // the column with a YYYYMM filter. The section is cached
          // alongside the columns block, so the prevention carries
          // forward into <known_objects>.
          //
          // dm_db_stats_histogram requires VIEW DATABASE STATE; the
          // try/catch silently degrades when the permission is absent
          // or the table has no auto-stats yet.
          const surrogateLikeNames = (result.recordset as Array<{ COLUMN_NAME: string; DATA_TYPE: string }>)
            .filter((c) => isSurrogateLikeColumn(c.COLUMN_NAME) && isIntegerLikeType(c.DATA_TYPE))
            .map((c) => c.COLUMN_NAME)
          if (schema && surrogateLikeNames.length > 0) {
            try {
              const rangeReq = pool.request()
                .input("schemaName", sql.NVarChar, schema)
                .input("tableName", sql.NVarChar, table)
              const rangeRes = await rangeReq.query(`
                DECLARE @oid INT = OBJECT_ID(QUOTENAME(@schemaName) + '.' + QUOTENAME(@tableName));
                IF @oid IS NULL
                  SELECT TOP 0 CAST(NULL AS NVARCHAR(128)) AS column_name,
                               CAST(NULL AS NVARCHAR(400)) AS min_val,
                               CAST(NULL AS NVARCHAR(400)) AS max_val;
                ELSE
                  SELECT c.name AS column_name,
                         MIN(CAST(h.range_high_key AS NVARCHAR(400))) AS min_val,
                         MAX(CAST(h.range_high_key AS NVARCHAR(400))) AS max_val
                  FROM sys.stats s
                  CROSS APPLY sys.dm_db_stats_histogram(s.object_id, s.stats_id) h
                  JOIN sys.stats_columns sc
                    ON sc.object_id = s.object_id AND sc.stats_id = s.stats_id AND sc.stats_column_id = 1
                  JOIN sys.columns c
                    ON c.object_id = s.object_id AND c.column_id = sc.column_id
                  WHERE s.object_id = @oid
                  GROUP BY c.name
              `)
              const wantSet = new Set(surrogateLikeNames.map((n) => n.toLowerCase()))
              const rows = (rangeRes.recordset as Array<{ column_name: string; min_val: string | null; max_val: string | null }>)
                .filter((r) => wantSet.has(r.column_name.toLowerCase()) && r.min_val !== null && r.max_val !== null)
              if (rows.length > 0) {
                const lines = rows.map((r) => `  ${r.column_name}: ${r.min_val}..${r.max_val}`)
                payload += `\n\nValue ranges (surrogate keys, from sys.stats histogram):\n` +
                  lines.join("\n") +
                  `\n  NOTE: these are real value ranges. A surrogate-key int does NOT encode YYYYMM/dates/business codes — filter via a JOIN to the dimension on its natural attributes (Year, MonthNo, …), not by the surrogate value.`
              }
            } catch {
              // Best-effort: missing VIEW DATABASE STATE or no auto-stats — silently skip.
            }
          }
          // Gap 1: persist the live result so the next call can short-circuit.
          // Only persist when we have a real schema-qualified qname AND a
          // fingerprint (the latter is a no-op when the catalog is unaware
          // of this object — correct, since we cannot validate freshness).
          if (schema) {
            const qn = `${schema}.${table}`
            const fp = fingerprintForQname(qn, connectionName)
            if (fp) persistToCache("explore_mssql_schema", qn, "columns", connectionName, payload, fp)
          }
          return payload
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
      return `SQL Error: ${decorateMssqlError(msg)}`
    }
  },
}

// ── Surrogate-shape helpers (used by explore_mssql_schema) ───────
//
// A column is "surrogate-key-shaped" when its NAME signals a synthetic
// identifier — i.e. its values don't encode any business attribute. We
// keep this list intentionally narrow so non-surrogate columns (Amount,
// Date, Year, MonthNo, …) never get range-decorated and the surrogate
// hint section in the payload stays compact and unambiguous.
function isSurrogateLikeColumn(name: string): boolean {
  const n = name.trim()
  if (/^(pk|fk|sk)[A-Z_]/.test(n)) return true        // pkMonth, fkClient, sk_account
  if (/^(pk|fk|sk)$/i.test(n)) return true            // bare pk / fk / sk
  if (/(Id|Key|Sk)$/.test(n) && n.length > 2) return true // CustomerId, AccountKey, BranchSk
  if (/_(id|key|sk)$/i.test(n)) return true           // customer_id, account_key
  return false
}

function isIntegerLikeType(dataType: string): boolean {
  const t = dataType.trim().toLowerCase()
  return t === "int" || t === "bigint" || t === "smallint" || t === "tinyint" || t === "numeric" || t === "decimal"
}

// ── Host-bound factories (Phase 4 item 6 — API surface only) ─────
//
// These factories lock in the `createXxxTool(host)` signature so the
// Phase 4 acceptance call-site swap is mechanical. Today the wrapped
// tools still read `currentRuntime()` internally (connection registry,
// per-run memory writer). The swap will rewrite `getPool` to take
// `host` and replace `currentRuntime().memory.writeNote` with the run
// context's writer.

import type { AgentHost } from "../../host/index.js"

export function createMssqlTool(_host: AgentHost): Tool {
  return {
    name: mssqlTool.name,
    description: mssqlTool.description,
    parameters: mssqlTool.parameters,
    execute: (args) => mssqlTool.execute(args),
  }
}

export function createMssqlSchemaTool(_host: AgentHost): Tool {
  return {
    name: mssqlSchemaTool.name,
    description: mssqlSchemaTool.description,
    parameters: mssqlSchemaTool.parameters,
    execute: (args) => mssqlSchemaTool.execute(args),
  }
}
