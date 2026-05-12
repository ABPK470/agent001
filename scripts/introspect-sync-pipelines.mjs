#!/usr/bin/env node
/**
 * scripts/introspect-sync-pipelines.mjs
 *
 * Reverse-engineer ABI's legacy sync pipelines into a declarative
 * `deploy/mssql/sync-recipes.json` artifact.
 *
 * GROUND TRUTH (verified 2026-04-27 against live UAT mymi DB):
 *   - core.Pipeline columns: pipelineId, name, properties, contractId, validFrom, validTo, changedBy, linkedServiceId, datasetId
 *   - core.Activity columns: activityId, pipelineId, name, description, action, properties (JSON), sequence, startCondition, validFrom, validTo, changedBy
 *   - The actual sproc to invoke is in `JSON_VALUE(properties, '$.storedProcedure')`
 *   - Per-table sync workhorse: core.uspSyncObjectTran @idName, @ids, @idsUnsync, @name, @schema, ...
 *   - PK columns are <table>Id (e.g. contractId, tableId), NOT pk<Table>
 *
 * Pipeline → Entity map (verified):
 *   788 → contract          → core.uspSyncCoreObjectsTran
 *   792 → dataset           → core.uspSyncDatasetObjectsTran
 *   791 → rule              → core.uspSyncRuleObjectsTran
 *   798 → pipelineActivity  → core.uspSyncPipelineObjectsTran
 *   780 → gateMetadata      → core.uspSyncDataListObjectsTran
 *   692 → content           → core.uspSyncContentObjectsTran
 *
 * What this script does:
 *   1. Connects to a SOURCE ABI environment (pass --connection=<name> when MSSQL_DATABASES is configured).
 *   2. For each known sync pipelineId:
 *        a. Reads core.Pipeline + core.Activity ordered by sequence.
 *        b. Parses each Activity's `properties` JSON to find the storedProcedure invoked.
 *        c. Identifies the entry-sproc (first match against known *ObjectsTran names).
 *        d. Fetches the entry-sproc body via OBJECT_DEFINITION.
 *        e. Extracts every `EXEC core.uspSyncObjectTran @idName='X', @name='Y', @schema='Z', ...` call site.
 *           These ARE the authoritative table+scope mappings.
 *   3. Computes FK reverse-closure rooted at each entity's PK column,
 *      restricted to {core, coreArchive, gate, gateArchive, master}.
 *   4. Reconciles pipeline-derived vs FK-derived sets:
 *        - Both       → "fk+pipeline" / verified
 *        - FK only    → "fk-only"     / discrepancy (legacy proc may miss rows)
 *        - Pipeline only → "pipeline-only" / verified
 *   5. Writes the reconciled bundle to `deploy/mssql/sync-recipes.json`.
 *
 * Usage:
 *   node scripts/introspect-sync-pipelines.mjs [--connection=<name>] [--dry-run]
 *
 * Env (from .env):
 *   MSSQL_HOST, MSSQL_PORT, MSSQL_USER, MSSQL_PASSWORD, MSSQL_DATABASE
 *   (or MSSQL_DATABASES JSON; --connection picks one)
 */

import { config as loadEnv } from "dotenv"
import sql from "mssql"
import { writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

loadEnv()

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, "..")
const RECIPES_PATH = resolve(PROJECT_ROOT, "deploy/mssql/sync-recipes.json")

const PIPELINE_ENTITY_MAP = {
  788: { entityType: "contract",         displayName: "Contract",              rootTable: "core.Contract",   rootKey: "contractId",  entrySproc: "core.uspSyncCoreObjectsTran"     },
  792: { entityType: "dataset",          displayName: "Dataset",               rootTable: "core.Dataset",    rootKey: "datasetId",   entrySproc: "core.uspSyncDatasetObjectsTran"  },
  791: { entityType: "rule",             displayName: "Rule",                  rootTable: "core.Rule",       rootKey: "ruleId",      entrySproc: "core.uspSyncRuleObjectsTran"     },
  798: { entityType: "pipelineActivity", displayName: "Pipeline & Activities", rootTable: "core.Pipeline",   rootKey: "pipelineId",  entrySproc: "core.uspSyncPipelineObjectsTran" },
  780: { entityType: "gateMetadata",     displayName: "Gate Metadata",         rootTable: "gate.MetaTable",  rootKey: "tableId",     entrySproc: "core.uspSyncDataListObjectsTran" },
  692: { entityType: "content",          displayName: "Content",               rootTable: "gate.Content",    rootKey: "contentId",   entrySproc: "core.uspSyncContentObjectsTran"  },
}

const ALLOWED_SCHEMAS = new Set(["core", "coreArchive", "gate", "gateArchive", "master"])

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [k, v] = a.slice(2).split("=")
    return [k, v ?? "true"]
  }),
)
const DRY_RUN = args["dry-run"] === "true"

// ── Connection setup ──────────────────────────────────────────────
function buildConfig() {
  const dbsJson = process.env.MSSQL_DATABASES
  if (dbsJson) {
    const dbs = JSON.parse(dbsJson)
    const wanted = args.connection || dbs[0]?.name
    const db = dbs.find((d) => d.name === wanted)
    if (!db) {
      throw new Error(`Connection "${wanted}" not found in MSSQL_DATABASES. Available: ${dbs.map((d) => d.name).join(", ")}`)
    }
    return {
      label: `${db.name} (${db.host}/${db.database})`,
      config: {
        server: db.host,
        port: db.port ?? 1433,
        ...(db.domain ? { domain: db.domain } : {}),
        user: db.user,
        password: db.password,
        database: db.database,
        options: { encrypt: db.encrypt !== false, trustServerCertificate: db.trustServerCertificate !== false },
        requestTimeout: 120_000,
      },
    }
  }
  if (!process.env.MSSQL_HOST) throw new Error("Set MSSQL_HOST or MSSQL_DATABASES in .env")
  return {
    label: `${process.env.MSSQL_HOST}/${process.env.MSSQL_DATABASE}`,
    config: {
      server: process.env.MSSQL_HOST,
      port: Number(process.env.MSSQL_PORT ?? 1433),
      ...(process.env.MSSQL_DOMAIN ? { domain: process.env.MSSQL_DOMAIN } : {}),
      user: process.env.MSSQL_USER,
      password: process.env.MSSQL_PASSWORD,
      database: process.env.MSSQL_DATABASE ?? "mymi",
      options: { encrypt: process.env.MSSQL_ENCRYPT !== "false", trustServerCertificate: process.env.MSSQL_TRUST_CERT !== "false" },
      requestTimeout: 120_000,
    },
  }
}

// ── Pipeline introspection ────────────────────────────────────────
async function fetchPipelineActivities(pool, pipelineId) {
  const result = await pool.request().query(`
    SELECT
      a.activityId,
      a.pipelineId,
      a.sequence,
      a.name        AS activityName,
      a.action,
      a.properties,
      JSON_VALUE(a.properties, '$.storedProcedure') AS sprocName
    FROM core.Activity a
    WHERE a.pipelineId = ${pipelineId}
    ORDER BY a.sequence
  `)
  return result.recordset
}

async function fetchProcDefinition(pool, qualifiedName) {
  const result = await pool.request().query(`SELECT OBJECT_DEFINITION(OBJECT_ID('${qualifiedName}')) AS body`)
  const raw = result.recordset[0]?.body || null
  if (!raw) return null
  // Normalise quadruple-quoted dynamic SQL ('''') → single quote (').
  // Both extractSyncObjectCalls and extractVariableDerivations need
  // the normalised form to regex-match parameter names and variable
  // derivation blocks correctly.
  return raw.replace(/''''/g, "'")
}

/**
 * Extract every `EXEC core.uspSyncObjectTran @idName='X', @ids=..., @name='Y', @schema='Z'`
 * call site from a sproc body.
 *
 * Returns [{ idName, idsVar, name, schema, qualified }].
 *
 * The legacy code uses dynamic SQL where parameters are quadruple-quoted, e.g.:
 *     '@idName = ''''contractId'''''
 *     ',@ids = '''' + @contractId + ''''
 *     ',@name = ''''Contract''''' + @newline +
 *     ',@schema = ''''core''''' + @newline +
 *
 * We collapse the quadruple-quotes and then run tolerant regexes.
 */
function extractSyncObjectCalls(body) {
  if (!body) return []
  const calls = []
  const chunks = body.split(/EXEC\s+core\.\[?uspSyncObjectTran\]?/gi)
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i].slice(0, 4000)
    const idName = chunk.match(/@idName\s*=\s*'([\w]+)'/i)?.[1]
    const name   = chunk.match(/@name\s*=\s*'([\w]+)'/i)?.[1]
    const schema = chunk.match(/@schema\s*=\s*'([\w]+)'/i)?.[1]
    // Extract @ids variable: find the first @variable after `@ids = <quoting/wrappers>`
    // Handles: @ids = '' + CONVERT(VARCHAR(MAX),ISNULL(@var,0)) + ''
    //          @ids = ' + @var + '   |   @ids = ' + CAST(@var ...) + '
    const idsMatch = chunk.match(/@ids\s*=\s*[^@\n]*?@(\w+)/i)
    const idsVar = idsMatch?.[1] ?? null
    if (idName && name && schema) {
      calls.push({ idName, idsVar, name, schema, qualified: `${schema}.${name}` })
    }
  }
  return calls
}

/**
 * Extract variable derivation assignments from the entry-sproc body.
 *
 * Finds the `SELECT @var = STUFF((SELECT ... CAST(col ...) FROM tbl WHERE cond FOR XML ...), ...)`
 * pattern that the legacy sprocs use to build comma-separated ID lists passed as @ids.
 *
 * Handles:
 *   - Simple single-SELECT STUFF blocks
 *   - UDF calls like `FROM core.fDeletedRulesTree(@param)`
 *   - UNION / UNION ALL blocks (e.g. inputDatasetId UNION outputDatasetId)
 *   - Table aliases and dotted column references (e.g. r.inputDatasetId)
 *
 * Returns Map<varNameLowerCase, derivation> where derivation is one of:
 *   - { parts: [...] }          — UNION: array of single-part objects
 *   - { column, fromTable, whereClause, isUdf, udfParam } — single derivation
 *   - { alias: string }         — SET @x = @y alias
 */
function extractVariableDerivations(body) {
  if (!body) return new Map()
  const derivations = new Map()

  // Strip single-line SQL comments (--...) to avoid matching commented-out STUFF blocks.
  // Preserve line structure so paren-walker positions stay valid.
  const cleaned = body.replace(/--[^\n]*/g, "")

  // Collect CTE names → { table, where } for resolving `FROM cte` references.
  // Captures the base table and optional WHERE clause from the CTE's anchor (first SELECT).
  const cteMap = new Map()
  const cteRe = /;?\s*WITH\s+(\w+)\s*\([^)]*\)\s*AS\s*\(\s*SELECT[\s\S]*?FROM\s+([\w.[\]]+)(?:\s+(?:AS\s+)?\w+)?(?:\s+WHERE\s+([\s\S]*?))?(?=\s+UNION\b|\s*\)\s*$)/gim
  let cm
  while ((cm = cteRe.exec(cleaned)) !== null) {
    cteMap.set(cm[1].toLowerCase(), {
      table: cm[2].replace(/\[|\]/g, ""),
      where: cm[3]?.trim() || null,
    })
  }

  const stuffRe = /SELECT\s+@(\w+)\s*=\s*STUFF\s*\(/gi
  let sm
  while ((sm = stuffRe.exec(cleaned)) !== null) {
    const varName = sm[1]
    const start = sm.index + sm[0].length
    // Walk forward counting parens to capture the full inner STUFF block.
    // Increased limit to 8000 to handle large sproc bodies with deep nesting.
    let depth = 1, pos = start, block = ""
    while (depth > 0 && pos < cleaned.length && pos < start + 8000) {
      if (cleaned[pos] === "(") depth++
      if (cleaned[pos] === ")") depth--
      if (depth > 0) block += cleaned[pos]
      pos++
    }

    // Strip everything from FOR XML onwards — FOR XML PATH is always the last clause
    // in the SELECT inside STUFF, possibly followed by ,TYPE).value(...) and STUFF closing args.
    // Handle both standard `  FOR XML` and dynamic SQL `+'FOR XML` patterns.
    let cleanBlock = block.replace(/\s*\+?\s*'?\s*FOR\s+XML\s+[\s\S]*/i, "").trim()
    // Safety: strip STUFF closing arguments if still present: ,1,1,'')
    cleanBlock = cleanBlock.replace(/,\s*1\s*,\s*1\s*,\s*(?:N?'[^']*'?|'')\s*$/i, "").trim()
    // Collapse doubled single-quotes from N-string escaping ('','' → ',')
    cleanBlock = cleanBlock.replace(/''/g, "'")
    // Strip outer parentheses left by the STUFF((SELECT ...)) wrapping
    cleanBlock = cleanBlock.replace(/^\s*\(\s*/, "").replace(/\s*\)\s*$/, "").trim()

    // Resolve CTE aliases in FROM clauses to real tables, injecting base WHERE if block has none
    let usedCteWhere = null
    const resolvedBlock = cleanBlock.replace(/\bFROM\s+(\w+)\b/gi, (m, tbl) => {
      const cte = cteMap.get(tbl.toLowerCase())
      if (!cte) return m
      if (cte.where && !/\bWHERE\b/i.test(cleanBlock)) usedCteWhere = cte.where
      return `FROM ${cte.table}`
    })
    // Inject CTE base WHERE clause if the STUFF block itself had no WHERE
    const finalBlock = usedCteWhere
      ? resolvedBlock.replace(/(FROM\s+[\w.]+)/i, `$1 WHERE ${usedCteWhere}`)
      : resolvedBlock

    // Split on UNION (ALL)? boundaries to handle multi-column derivations.
    // Lookahead ensures we don't eat the SELECT keyword.
    const unionParts = finalBlock.split(/\bUNION\s+(?:ALL\s+)?(?=SELECT\b)/i)

    const parts = []
    for (const part of unionParts) {
      const parsed = parseSingleDerivationBlock(part)
      if (parsed) parts.push(parsed)
    }

    if (parts.length === 1) {
      derivations.set(varName.toLowerCase(), parts[0])
    } else if (parts.length > 1) {
      derivations.set(varName.toLowerCase(), { parts })
    }
  }

  // Also pick up simple SET @var = @other (alias assignments)
  const setRe = /SET\s+@(\w+)\s*=\s*@(\w+)\s*$/gim
  while ((sm = setRe.exec(cleaned)) !== null) {
    const key = sm[1].toLowerCase()
    if (!derivations.has(key)) {
      derivations.set(key, { alias: sm[2].toLowerCase() })
    }
  }

  // Handle concatenation assignments: SET @var = COALESCE(@x + ...) + @y
  // e.g. SET @ruleDatasetIds = COALESCE(@ruleOutputDatasetIds + ', ','') + @ruleInputDatasetIds
  // Treat as UNION of all referenced derivation variables.
  const assignRe = /SET\s+@(\w+)\s*=\s*(.+)/gim
  while ((sm = assignRe.exec(cleaned)) !== null) {
    const key = sm[1].toLowerCase()
    if (derivations.has(key)) continue
    if (key.startsWith('sql')) continue // skip SET @sqlXxx = N'...' dynamic SQL
    const expr = sm[2]
    if (expr.trimStart().startsWith("N'")) continue // skip N-string assignments
    const refs = []
    const refRe = /@(\w+)/g
    let rm
    while ((rm = refRe.exec(expr)) !== null) {
      const refKey = rm[1].toLowerCase()
      if (derivations.has(refKey)) refs.push(refKey)
    }
    if (refs.length > 0) {
      const parts = []
      for (const ref of refs) {
        const d = derivations.get(ref)
        if (d.parts) parts.push(...d.parts)
        else if (!d.alias) parts.push(d)
      }
      if (parts.length > 0) derivations.set(key, parts.length === 1 ? parts[0] : { parts })
    }
  }

  // Handle sp_executesql patterns that map an inner parameter to an outer variable.
  // Pattern:
  //   EXEC [sys.]sp_executesql @sqlXxx, N'@innerParam type out', @outerVar OUT
  // If the STUFF parser already captured @innerParam as a derivation, create an alias
  // from @outerVar → @innerParam.  This resolves dynamic SQL derivation chains like
  // @jsonSchemaIds (outer) → @contentJsonSchemaIds (inner STUFF variable).
  const spExecRe = /EXEC\s+(?:sys\.)?sp_executesql\s+@(\w+)\s*,\s*N'@(\w+)\s+[^']+?\bout\b'\s*,\s*@(\w+)\s+OUT/gi
  while ((sm = spExecRe.exec(cleaned)) !== null) {
    const innerParam = sm[2].toLowerCase()
    const outerVar = sm[3].toLowerCase()
    if (outerVar === innerParam) continue // same name, no alias needed
    if (derivations.has(outerVar)) continue // already resolved
    if (derivations.has(innerParam)) {
      derivations.set(outerVar, { alias: innerParam })
    }
  }

  return derivations
}

/**
 * Parse a single SELECT block from a STUFF expression into a derivation object.
 * Handles UDF FROM, standard FROM/WHERE, and dotted column references.
 */
function parseSingleDerivationBlock(block) {
  // Extract column name from CAST(col AS type) or CONVERT(type, col) — handle optional table alias
  const castMatch = block.match(/CAST\s*\(\s*(?:\w+\.)?(\w+)\s+AS/i)
  const convertMatch = block.match(/CONVERT\s*\(\s*\w+(?:\(\w+\))?\s*,\s*(?:\w+\.)?(\w+)\s*\)/i)
  const castCol = castMatch?.[1] ?? convertMatch?.[1]
  if (!castCol) return null

  // UDF form: FROM schema.func(@param)
  const udfMatch = block.match(/FROM\s+([\w.[\]]+)\s*\(\s*@(\w+)\s*\)/i)
  if (udfMatch) {
    return {
      column: castCol,
      fromTable: udfMatch[1].replace(/\[|\]/g, ""),
      whereClause: null,
      isUdf: true,
      udfParam: udfMatch[2],
    }
  }

  // Standard form: FROM schema.Table [alias] [WHERE cond]
  // The WHERE clause extends to end of block (FOR XML already stripped).
  const stdMatch = block.match(/FROM\s+([\w.[\]]+)(?:\s+(?:AS\s+)?(\w+))?\s+WHERE\s+([\s\S]+)/i)
  if (stdMatch) {
    let where = stdMatch[3].trim()
    // Safety: strip any lingering FOR XML that slipped through
    where = where.replace(/\bFOR\s+XML\b[\s\S]*/i, "").trim()
    // Strip dynamic SQL string interpolation: ' + expr + ' → expr
    where = where.replace(/'\s*\+\s*([^+]+?)\s*\+\s*'/g, " $1 ").trim()
    // Remove quote+plus / plus+quote string concatenation operators from dynamic SQL
    where = where.replace(/'+\s*\+/g, " ").replace(/\+\s*'+/g, " ").trim()
    // Strip CONVERT/ISNULL wrappers around @variables (dynamic SQL artifacts)
    where = where.replace(/CONVERT\s*\([^,]+,\s*(@\w+)\s*\)/gi, "$1")
    where = where.replace(/ISNULL\s*\(\s*(@\w+)\s*,[^)]*\)/gi, "$1")
    // Remove @newline, N-string fragments, and trailing concatenation artifacts
    where = where.replace(/@newline\b/gi, "").trim()
    where = where.replace(/\s*\+?\s*N'[^']*'?/g, "").trim()
    where = where.replace(/\s*\+[\s\S]*$/i, "").trim()
    // Strip STUFF(COALESCE(...)) dynamic SQL artifacts: these build comma-separated lists.
    // Replace with just the relevant @variable references (skip @deleted*, @sql*, @newline).
    where = where.replace(/\bSTUFF\s*\([\s\S]*/i, (m) => {
      const vars = [...m.matchAll(/@(\w+)/g)]
        .map(x => x[1])
        .filter(v => !/^(newline|sql)/i.test(v) && !/^deleted/i.test(v))
      return vars.length > 0 ? vars.map(v => `@${v}`).join(', ') : m
    })
    // Strip trailing parameter-list fragments: ,TYPE = ..., ,@param ...
    where = where.replace(/\s*,\s*(?:@?\w+\s*=[\s\S]*$|'[\s\S]*$)/i, "").trim()
    // Strip trailing quotes
    where = where.replace(/'+\s*$/g, "").trim()
    // Strip trailing table aliases: ) AS t, ) AS alias
    where = where.replace(/\)\s+AS\s+\w+\s*$/i, ")").trim()
    // Normalize whitespace
    where = where.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim()
    return {
      column: castCol,
      fromTable: stdMatch[1].replace(/\[|\]/g, ""),
      whereClause: where,
      isUdf: false,
      udfParam: null,
    }
  }

  // FROM without WHERE (all rows from table)
  const fromOnly = block.match(/FROM\s+([\w.[\]]+)/i)
  if (fromOnly) {
    return {
      column: castCol,
      fromTable: fromOnly[1].replace(/\[|\]/g, ""),
      whereClause: null,
      isUdf: false,
      udfParam: null,
    }
  }

  return null
}

/** Bracket-quote a dotted identifier for use inside generated predicates. */
function qtable(name) {
  return name.split(".").map((p) => `[${p}]`).join(".")
}

/**
 * Resolve a single derivation part into a SELECT subquery string.
 * Used by resolveIdsPredicate for both single and UNION derivations.
 *
 * @returns {string|null} e.g. "SELECT col FROM [schema].[Table] WHERE ..."
 */
function resolveSinglePart(d, rootParam, derivations) {
  if (d.isUdf) {
    return `SELECT ${d.column} FROM ${qtable(d.fromTable)}({id})`
  }

  if (d.whereClause) {
    // Replace @rootParam and @rootParams (pluralised sproc parameter convention) with {id}
    let where = d.whereClause.replace(new RegExp(`@${rootParam}s?\\b`, "gi"), "{id}")

    // Resolve nested @variable references in the WHERE clause.
    // Collect all replacements first to avoid mutating `where` while regex iterates.
    const replacements = []
    const nestedRe = /@(\w+)/g
    let nm
    while ((nm = nestedRe.exec(where)) !== null) {
      const nestedVar = nm[1]
      const nestedD = derivations.get(nestedVar.toLowerCase())
      if (!nestedD) continue

      const innerExpr = resolveDerivationToSubquery(nestedD, rootParam, derivations)
      if (innerExpr) replacements.push({ varName: nestedVar, expr: innerExpr })
    }

    for (const { varName, expr } of replacements) {
      // Handle dynamic-SQL concatenation: ' + @var + ' → (subquery)
      where = where
        .replace(new RegExp(`'\\s*\\+\\s*@${varName}\\s*\\+\\s*'`, "gi"), `(${expr})`)
        .replace(new RegExp(`@${varName}`, "gi"), `(${expr})`)
    }

    return `SELECT ${d.column} FROM ${qtable(d.fromTable)} WHERE ${where}`
  }

  if (d.column && d.fromTable) {
    return `SELECT ${d.column} FROM ${qtable(d.fromTable)}`
  }

  return null
}

/**
 * Resolve any derivation (single, UNION, or alias) to a subquery string.
 * Recursive for alias chains.
 */
function resolveDerivationToSubquery(d, rootParam, derivations) {
  if (d.alias) {
    const aliased = derivations.get(d.alias)
    return aliased ? resolveDerivationToSubquery(aliased, rootParam, derivations) : null
  }
  if (d.parts) {
    const subs = d.parts.map((p) => resolveSinglePart(p, rootParam, derivations)).filter(Boolean)
    return subs.length > 0 ? subs.join(" UNION ") : null
  }
  return resolveSinglePart(d, rootParam, derivations)
}

/** Normalize whitespace in a predicate string: collapse \r\n, \t, multiple spaces, strip aliases, balance parens. */
function normalizePredicate(pred) {
  let result = pred
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\)\s+AS\s+\w+/gi, ")")
    .trim()

  // Balance parentheses: strip excess trailing ')' or append missing ')'
  const opens = (result.match(/\(/g) || []).length
  const closes = (result.match(/\)/g) || []).length
  if (closes > opens) {
    // Strip excess trailing close-parens
    let excess = closes - opens
    result = result.replace(/\)+\s*$/, (m) => m.slice(0, m.length - excess))
  } else if (opens > closes) {
    result += ")".repeat(opens - closes)
  }

  return result
}

/**
 * Given an @ids variable name from an EXEC call and the variable derivation map,
 * build the actual scope predicate for this table.
 *
 * @param {string} idName      - The @idName parameter (= scopeColumn)
 * @param {string|null} idsVar - The variable name used for @ids
 * @param {Map} derivations    - From extractVariableDerivations
 * @param {string} rootKey     - Root entity PK column (e.g. "contractId")
 * @param {string} rootParam   - Root sproc parameter (usually same as rootKey)
 * @returns {string|null}      - The predicate template, or null if unresolvable
 */
function resolveIdsPredicate(idName, idsVar, derivations, rootKey, rootParam) {
  if (!idsVar) return null
  const idsLower = idsVar.toLowerCase()
  const rootLower = rootParam.toLowerCase()

  // Case 1: @ids = @rootParam → direct equality
  if (idsLower === rootLower || idsLower === rootKey.toLowerCase()) {
    return `${idName} = {id}`
  }

  // Case 2: Alias resolution (SET @x = @y)
  const d = derivations.get(idsLower)

  // Case 1b: @ids = @rootParam + 's' (pluralised sproc parameter convention)
  // e.g. @datasetIds is the sproc input parameter when rootKey = 'datasetId'
  // Only applies when there's no derived variable by that name.
  if (!d && idsLower === rootLower + 's') {
    return `${idName} = {id}`
  }

  if (!d) return null
  if (d.alias) {
    return resolveIdsPredicate(idName, d.alias, derivations, rootKey, rootParam)
  }

  // Case 3: UNION derivation → build UNION subquery
  if (d.parts) {
    const subqueries = d.parts
      .map((part) => resolveSinglePart(part, rootParam, derivations))
      .filter(Boolean)
    if (subqueries.length === 0) return null
    return normalizePredicate(`${idName} IN (${subqueries.join(" UNION ")})`)
  }

  // Case 4: Single derivation (UDF, standard subquery, or bare FROM)
  const resolved = resolveSinglePart(d, rootParam, derivations)
  if (!resolved) return null
  return normalizePredicate(`${idName} IN (${resolved})`)
}

// ── FK closure ────────────────────────────────────────────────────
async function fetchFkEdges(pool) {
  const result = await pool.request().query(`
    SELECT
      OBJECT_SCHEMA_NAME(fkc.parent_object_id)     AS childSchema,
      OBJECT_NAME(fkc.parent_object_id)            AS childTable,
      pc.name                                      AS childColumn,
      OBJECT_SCHEMA_NAME(fkc.referenced_object_id) AS parentSchema,
      OBJECT_NAME(fkc.referenced_object_id)        AS parentTable,
      rc.name                                      AS parentColumn
    FROM sys.foreign_key_columns fkc
    JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id     AND pc.column_id = fkc.parent_column_id
    JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
    WHERE OBJECT_SCHEMA_NAME(fkc.parent_object_id)     IN ('core','coreArchive','gate','gateArchive','master')
       OR OBJECT_SCHEMA_NAME(fkc.referenced_object_id) IN ('core','coreArchive','gate','gateArchive','master')
  `)
  return result.recordset
}

function fkClosure(rootTable, rootKey, edges) {
  const adj = new Map()
  for (const e of edges) {
    const p = `${e.parentSchema}.${e.parentTable}`
    const c = `${e.childSchema}.${e.childTable}`
    if (!adj.has(p)) adj.set(p, [])
    adj.get(p).push({ child: c, childColumn: e.childColumn, parentColumn: e.parentColumn })
  }
  const visited = new Map()
  visited.set(rootTable, {
    scopeColumn: rootKey, predicate: `${rootKey} = {id}`, source: "fk-only",
    hasRootKey: true, fromParent: null,
  })
  const queue = [rootTable]
  while (queue.length) {
    const cur = queue.shift()
    const curInfo = visited.get(cur)
    const children = adj.get(cur) || []
    for (const { child, childColumn, parentColumn } of children) {
      if (visited.has(child)) continue
      const [schema] = child.split(".")
      if (!ALLOWED_SCHEMAS.has(schema)) continue

      const fromParent = { parentTable: cur, childCol: childColumn, parentCol: parentColumn }
      let predicate, scopeColumn, hasRootKey

      if (parentColumn === rootKey) {
        // Direct FK to root key — simple equality
        predicate = `${childColumn} = {id}`
        scopeColumn = childColumn
        hasRootKey = true
      } else if (curInfo.hasRootKey) {
        // Parent has rootKey directly — single-hop EXISTS
        predicate = `EXISTS (SELECT 1 FROM ${qtable(cur)} p WHERE p.${parentColumn} = ${qtable(child)}.${childColumn} AND p.${rootKey} = {id})`
        scopeColumn = null
        hasRootKey = false
      } else {
        // Parent does NOT have rootKey — build a multi-hop JOIN chain
        // Walk up the fromParent chain until we reach a table with hasRootKey
        const joins = []
        let walkTable = cur
        let walkInfo = curInfo
        let aliasIdx = 0
        while (walkInfo && !walkInfo.hasRootKey && walkInfo.fromParent) {
          const fp = walkInfo.fromParent
          aliasIdx++
          const rightAlias = aliasIdx === 1 ? "p" : `_p${aliasIdx - 1}`
          joins.push(
            `INNER JOIN ${qtable(fp.parentTable)} _p${aliasIdx} ON _p${aliasIdx}.${fp.parentCol} = ${rightAlias}.${fp.childCol}`
          )
          walkTable = fp.parentTable
          walkInfo = visited.get(walkTable)
        }
        const rootRef = aliasIdx > 0 ? `_p${aliasIdx}` : "p"
        predicate = `EXISTS (SELECT 1 FROM ${qtable(cur)} p ${joins.join(" ")} WHERE p.${parentColumn} = ${qtable(child)}.${childColumn} AND ${rootRef}.${rootKey} = {id})`
        scopeColumn = null
        hasRootKey = false
      }

      visited.set(child, { scopeColumn, predicate, source: "fk-only", hasRootKey, fromParent })
      queue.push(child)
    }
  }
  return visited
}

// ── PK column lookup ──────────────────────────────────────────────
// ── Recipe synthesis ──────────────────────────────────────────────
async function buildRecipe(pool, pipelineId, fkEdges) {
  const meta = PIPELINE_ENTITY_MAP[pipelineId]
  if (!meta) throw new Error(`Unknown pipeline ${pipelineId}`)

  console.log(`\n── Pipeline ${pipelineId}: ${meta.entityType} (root ${meta.rootTable}.${meta.rootKey})`)

  // 1. FK closure
  const fkTables = fkClosure(meta.rootTable, meta.rootKey, fkEdges)
  console.log(`  FK closure: ${fkTables.size} tables`)

  // 2. Pipeline activities → identify entry sproc
  const activities = await fetchPipelineActivities(pool, pipelineId)
  console.log(`  Activities: ${activities.length}`)

  // 3. Read entry-sproc body
  const entryBody = await fetchProcDefinition(pool, meta.entrySproc)
  if (!entryBody) {
    console.warn(`  ! Entry sproc ${meta.entrySproc} not found in DB.`)
  }

  // 4. Extract uspSyncObjectTran call sites + variable derivations
  const calls = entryBody ? extractSyncObjectCalls(entryBody) : []
  const derivations = entryBody ? extractVariableDerivations(entryBody) : new Map()
  console.log(`  Pipeline-derived sync calls: ${calls.length} (${calls.map((c) => c.qualified).join(", ")})`)
  console.log(`  Variable derivations: ${derivations.size} (${[...derivations.keys()].join(", ")})`)

  // 5. Build pipeline table map with proper predicates
  const pipelineTables = new Map()
  for (const c of calls) {
    if (pipelineTables.has(c.qualified)) continue

    // Try to resolve the @ids variable back to a real predicate
    const resolved = resolveIdsPredicate(c.idName, c.idsVar, derivations, meta.rootKey, meta.rootKey)
    const predicate = resolved
      ?? (c.idName === meta.rootKey
        ? `${c.idName} = {id}`
        : `${c.idName} IN (/* UNRESOLVED: @${c.idsVar ?? "?"} — review legacy pipeline variable derivation */)`)

    pipelineTables.set(c.qualified, {
      scopeColumn: c.idName,
      predicate,
      predicateResolved: !!resolved,
    })
  }

  // 6. Reconcile FK + pipeline sets (case-insensitive table name matching)
  // FK graph uses sys.tables casing (e.g. gate.MetaTable), pipeline uses @name param casing
  // (e.g. gate.metaTable).  Build a lowercase → canonical name map from FK graph (authoritative casing).
  const fkLowerMap = new Map()  // lowercase → FK canonical name
  for (const t of fkTables.keys()) fkLowerMap.set(t.toLowerCase(), t)

  const pipeLowerMap = new Map() // lowercase → pipeline canonical name
  for (const t of pipelineTables.keys()) pipeLowerMap.set(t.toLowerCase(), t)

  // Merge both sets using lowercase keys, preferring FK casing (from sys.tables)
  const allLowerKeys = new Set([...fkLowerMap.keys(), ...pipeLowerMap.keys()])
  const tables = []
  const discrepancies = []
  for (const lk of allLowerKeys) {
    const canonicalName = fkLowerMap.get(lk) ?? pipeLowerMap.get(lk)

    const fkKey = fkLowerMap.get(lk)
    const pipeKey = pipeLowerMap.get(lk)
    const inFk = !!fkKey
    const inPipeline = !!pipeKey
    const fkInfo = fkKey ? fkTables.get(fkKey) : null
    const pipeInfo = pipeKey ? pipelineTables.get(pipeKey) : null
    let source, verified, scopeColumn, predicate

    if (inFk && inPipeline) {
      source = "fk+pipeline"
      scopeColumn = pipeInfo.scopeColumn
      // Use the pipeline-derived predicate (authoritative); verified if we could resolve it
      predicate = pipeInfo.predicateResolved ? pipeInfo.predicate : (fkInfo.predicate || pipeInfo.predicate)
      verified = pipeInfo.predicateResolved
    } else if (inFk) {
      // FK-only: table reachable via FK graph but not explicitly synced by the sproc.
      // Keep these as opt-in only: they are inferred from relational closure,
      // not grounded by an explicit legacy pipeline step.
      source = "fk-only"; verified = false
      scopeColumn = fkInfo.scopeColumn
      predicate = fkInfo.predicate
    } else {
      // pipeline-only: table synced by sproc but not FK-reachable (e.g. via UDF or indirect join)
      source = "pipeline-only"
      scopeColumn = pipeInfo.scopeColumn
      predicate = pipeInfo.predicate
      verified = pipeInfo.predicateResolved
      if (!pipeInfo.predicateResolved) {
        discrepancies.push({ table: canonicalName, kind: "implicit", note: `Synced by ${meta.entrySproc} but predicate could not be auto-resolved from the legacy pipeline body.` })
      }
    }

    const entry = {
      name: canonicalName,
      scopeColumn,
      predicate,
      source,
      verified,
      groundedByPipeline: source !== "fk-only",
      enabledByDefault: source !== "fk-only",
      userControllable: source === "fk-only",
    }
    if (!verified && !pipeInfo?.predicateResolved) {
      entry.note = `Predicate ${pipeInfo?.predicateResolved === false ? "unresolved from @" + (calls.find((c) => c.qualified === canonicalName || c.qualified.toLowerCase() === lk)?.idsVar ?? "?") : "inferred from FK graph"}. Verify against ${meta.entrySproc} body.`
    }
    tables.push(entry)

    const status = verified ? "✓" : "⚠"
    console.log(`  ${status} ${canonicalName} → ${predicate.slice(0, 80)}${predicate.length > 80 ? "…" : ""}`)
  }

  // 7. Execution order = pipeline call order (calls already in declared sequence within entry sproc)
  // Use case-insensitive matching to map pipeline call names to canonical FK names.
  const callOrder = calls.map((c) => fkLowerMap.get(c.qualified.toLowerCase()) ?? c.qualified)
  const seen = new Set()
  const executionOrder = []
  for (const q of callOrder) {
    if (!seen.has(q)) { executionOrder.push(q); seen.add(q) }
  }
  // Append any FK-only tables not in pipeline order
  for (const t of tables) {
    if (!seen.has(t.name)) { executionOrder.push(t.name); seen.add(t.name) }
  }
  const reverseOrder = [...executionOrder].reverse()

  // Detect self-referencing FK on the root table (e.g. core.Rule.parentRuleId → core.Rule.ruleId).
  // When found, the sync engine uses a recursive CTE to expand the entity ID to the full tree.
  const selfJoinColumn = detectSelfJoinColumn(meta.rootTable, meta.rootKey, fkEdges)

  return {
    entityType: meta.entityType,
    displayName: meta.displayName,
    rootTable: meta.rootTable,
    rootKeyColumn: meta.rootKey,
    rootNameColumn: "name",
    selfJoinColumn,
    legacyPipelineId: pipelineId,
    legacyEntrySproc: meta.entrySproc,
    tables,
    executionOrder,
    reverseOrder,
    discrepancies,
    generatedAt: new Date().toISOString(),
  }
}

/**
 * Check if a root table has a self-referencing FK — a column that references
 * the same table's PK (e.g. core.Rule.parentRuleId → core.Rule.ruleId).
 * Returns the FK column name or null.
 */
function detectSelfJoinColumn(rootTable, rootKey, fkEdges) {
  const [schema, table] = rootTable.split(".")
  for (const e of fkEdges) {
    if (
      e.childSchema === schema && e.childTable === table &&
      e.parentSchema === schema && e.parentTable === table &&
      e.parentColumn === rootKey && e.childColumn !== rootKey
    ) {
      return e.childColumn
    }
  }
  return null
}

// ── Main ──────────────────────────────────────────────────────────

// Export pure functions for unit testing
export {
    detectSelfJoinColumn,
    extractSyncObjectCalls,
    extractVariableDerivations, fkClosure, normalizePredicate, parseSingleDerivationBlock, qtable, resolveDerivationToSubquery, resolveIdsPredicate,
    resolveSinglePart
}

async function main() {
  const { label, config } = buildConfig()
  console.log(`Connecting to: ${label}`)
  const pool = await sql.connect(config)

  const fkEdges = await fetchFkEdges(pool)
  console.log(`Loaded ${fkEdges.length} FK edges across {${[...ALLOWED_SCHEMAS].join(",")}}`)

  const recipes = {}
  let totalVerified = 0, totalTables = 0
  for (const [idStr, meta] of Object.entries(PIPELINE_ENTITY_MAP)) {
    const id = Number(idStr)
    try {
      const recipe = await buildRecipe(pool, id, fkEdges)
      recipes[meta.entityType] = recipe
      const v = recipe.tables.filter((t) => t.verified).length
      totalVerified += v; totalTables += recipe.tables.length
      console.log(`  Result: ${v}/${recipe.tables.length} verified, ${recipe.discrepancies.length} discrepancies`)
    } catch (e) {
      console.error(`  ✗ Pipeline ${id} failed: ${e.message}`)
      recipes[meta.entityType] = null
    }
  }

  console.log(`\n═══ TOTAL: ${totalVerified}/${totalTables} tables verified across ${Object.keys(recipes).length} recipes ═══`)

  const bundle = {
    version: 1,
    generatedAt: new Date().toISOString(),
    introspectedFrom: label,
    _comment: "Auto-generated by scripts/introspect-sync-pipelines.mjs from legacy pipeline calls plus FK inference. FK-only entries are optional and default-off.",
    recipes,
  }

  if (DRY_RUN) {
    console.log("\n--- DRY RUN — would write ---\n")
    console.log(JSON.stringify(bundle, null, 2))
  } else {
    writeFileSync(RECIPES_PATH, JSON.stringify(bundle, null, 2) + "\n")
    console.log(`\n✓ Wrote ${RECIPES_PATH}`)
  }

  await pool.close()
}

// Only run main when executed directly (not when imported as a module for testing)
const isMain = process.argv[1] && fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/^.*(?=scripts\/)/, ""))
if (isMain) {
  main().catch((e) => {
    console.error("Introspection failed:", e)
    process.exit(1)
  })
}
