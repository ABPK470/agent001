#!/usr/bin/env node

import "dotenv/config"

import sql from "mssql"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { parseArgs } from "node:util"

const DEFAULT_CONTRACT_IDS = [4988, 4641]
const QUALIFIED_TABLE = "core.DatasetMappingColumn"
const META_EXCLUDED_COLUMNS = new Set(["validFrom", "validTo", "isLocked", "syncDate", "deployDate"])
const DETERMINISTIC_SESSION_PREFIX =
  "SET LANGUAGE us_english; " +
  "SET DATEFORMAT ymd; " +
  "SET NUMERIC_ROUNDABORT OFF; " +
  "SET ANSI_WARNINGS ON; " +
  "SET ANSI_PADDING ON; " +
  "SET ANSI_NULLS ON; " +
  "SET CONCAT_NULL_YIELDS_NULL ON; " +
  "SET ARITHABORT ON; " +
  "SET QUOTED_IDENTIFIER ON; "

const LEGACY_PREDICATE =
  "EXISTS (" +
  "SELECT 1 " +
  "FROM [core].[DatasetMapping] dm " +
  "INNER JOIN [core].[Dataset] d ON d.[datasetId] = dm.[datasetId_Left] " +
  "WHERE dm.[datasetMappingId] = [core].[DatasetMappingColumn].[datasetMappingId] " +
  "AND d.[contractId] = {id}" +
  ")"

function usage(message) {
  if (message) console.error(message)
  console.error(
    [
      "Usage:",
      "  node scripts/check-contract-dataset-mapping-column-scope.mjs \\",
      "    [--source uat] [--target dev] [--contract 4988 --contract 4641] [--json]",
      "",
      "Defaults:",
      "  --source uat",
      "  --target dev",
      "  --contract 4988 --contract 4641",
      "",
      "Connection configs come from MSSQL_DATABASES in .env."
    ].join("\n")
  )
  process.exit(1)
}

function qtable(name) {
  return name
    .split(".")
    .map((part) => `[${part.replace(/]/g, "]]")}]`)
    .join(".")
}

function quoteValue(value) {
  if (value === null || value === undefined) return "NULL"
  if (typeof value === "number") return String(value)
  if (typeof value === "boolean") return value ? "1" : "0"
  return `N'${String(value).replace(/'/g, "''")}'`
}

function formatScalar(value) {
  if (value === null || value === undefined) return "NULL"
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return `'${String(value)}'`
}

function hashExpr(column) {
  const col = `[${column.name}]`
  switch (column.systemType) {
    case "datetime":
    case "datetime2":
    case "smalldatetime":
    case "datetimeoffset":
      return `CONVERT(NVARCHAR(33), ${col}, 126)`
    case "date":
      return `CONVERT(NVARCHAR(10), ${col}, 23)`
    case "time":
      return `CONVERT(NVARCHAR(16), ${col}, 114)`
    case "float":
    case "real":
      return `CONVERT(NVARCHAR(64), ${col}, 2)`
    case "money":
    case "smallmoney":
      return `CONVERT(NVARCHAR(32), ${col}, 2)`
    case "binary":
    case "varbinary":
    case "image":
    case "timestamp":
    case "rowversion":
      return `CONVERT(NVARCHAR(MAX), ${col}, 1)`
    case "uniqueidentifier":
      return `CONVERT(NVARCHAR(36), ${col})`
    case "xml":
    case "hierarchyid":
    case "geography":
    case "geometry":
    case "sql_variant":
      return `CONVERT(NVARCHAR(MAX), CONVERT(VARBINARY(MAX), ${col}), 1)`
    default:
      return `CAST(${col} AS NVARCHAR(MAX))`
  }
}

function instantiatePredicate(predicate, contractId) {
  return predicate.replaceAll("{id}", String(contractId))
}

function readPublishedPredicate(repoRoot) {
  const bundlePath = resolve(repoRoot, "sync-definitions/published/definitions.bundle.json")
  const bundle = JSON.parse(readFileSync(bundlePath, "utf8"))
  const contract = bundle?.definitions?.contract
  if (!contract) throw new Error(`Contract definition missing in ${bundlePath}`)
  const table = contract.metadata?.tables?.find((entry) => entry.name === QUALIFIED_TABLE)
  if (!table?.predicate || !table?.scopeColumn) {
    throw new Error(`${QUALIFIED_TABLE} missing predicate/scopeColumn in published contract definition.`)
  }
  return { predicate: table.predicate, scopeColumn: table.scopeColumn, bundlePath }
}

function loadAllMssqlDatabaseConfigs() {
  const raw = process.env.MSSQL_DATABASES
  if (!raw) {
    throw new Error(
      "MSSQL_DATABASES is not set. Load .env or export MSSQL_DATABASES before running this script."
    )
  }
  let configs
  try {
    configs = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `MSSQL_DATABASES is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!Array.isArray(configs)) throw new Error("MSSQL_DATABASES must be a JSON array.")
  return configs
}

function resolveMssqlConfig(configs, connectionName) {
  const wanted = String(connectionName).toLowerCase()
  const match = configs.find((entry) => String(entry?.name ?? "").toLowerCase() === wanted)
  if (!match) {
    const known =
      configs
        .map((entry) => entry?.name)
        .filter(Boolean)
        .join(", ") || "none"
    throw new Error(`Connection \"${connectionName}\" not found in MSSQL_DATABASES. Available: ${known}`)
  }
  return {
    name: match.name,
    config: {
      server: match.host,
      port: match.port ? Number(match.port) : undefined,
      database: match.database,
      user: match.user,
      password: match.password,
      domain: match.domain,
      options: {
        encrypt: true,
        trustServerCertificate: true
      },
      pool: {
        min: 0,
        max: 4,
        idleTimeoutMillis: 30_000
      },
      requestTimeout: 300_000,
      connectionTimeout: 30_000
    }
  }
}

async function fetchContractExists(pool, contractId) {
  const result = await pool
    .request()
    .input("contractId", sql.Int, contractId)
    .query(
      "SELECT CASE WHEN EXISTS (SELECT 1 FROM [core].[Contract] WHERE [contractId] = @contractId) THEN 1 ELSE 0 END AS existsFlag"
    )
  return Number(result.recordset[0]?.existsFlag ?? 0) === 1
}

async function fetchTableTotal(pool) {
  const result = await pool.request().query(`SELECT COUNT_BIG(*) AS cnt FROM ${qtable(QUALIFIED_TABLE)}`)
  return Number(result.recordset[0]?.cnt ?? 0)
}

async function fetchPkColumns(pool, qualifiedTable) {
  const [schemaName, tableName] = qualifiedTable.split(".")
  const result = await pool
    .request()
    .query(
      [
        "SELECT c.name AS columnName",
        "FROM sys.indexes i",
        "JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id",
        "JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id",
        "JOIN sys.objects o ON o.object_id = i.object_id",
        `WHERE i.is_primary_key = 1 AND o.name = ${quoteValue(tableName)} AND OBJECT_SCHEMA_NAME(o.object_id) = ${quoteValue(schemaName)}`,
        "ORDER BY ic.key_ordinal"
      ].join("\n")
    )
  const pkColumns = result.recordset.map((row) => row.columnName)
  if (pkColumns.length === 0) throw new Error(`No PK columns found for ${qualifiedTable}`)
  return pkColumns
}

async function fetchTableColumns(pool, qualifiedTable) {
  const [schemaName, tableName] = qualifiedTable.split(".")
  const result = await pool
    .request()
    .query(
      [
        "SELECT",
        "  c.name AS columnName,",
        "  c.is_computed AS isComputed,",
        "  c.is_identity AS isIdentity,",
        "  LOWER(ty.name) AS systemType",
        "FROM sys.columns c",
        "JOIN sys.objects o ON o.object_id = c.object_id",
        "JOIN sys.types ty ON ty.user_type_id = c.user_type_id",
        "WHERE o.[type] = 'U'",
        `  AND o.name = ${quoteValue(tableName)}`,
        `  AND OBJECT_SCHEMA_NAME(c.object_id) = ${quoteValue(schemaName)}`,
        "ORDER BY c.column_id"
      ].join("\n")
    )
  const hashColumns = []
  for (const row of result.recordset) {
    if (row.isIdentity) continue
    if (row.isComputed) continue
    if (META_EXCLUDED_COLUMNS.has(row.columnName)) continue
    hashColumns.push({ name: row.columnName, systemType: row.systemType })
  }
  if (hashColumns.length === 0) throw new Error(`${qualifiedTable} has no comparable columns for hashing.`)
  return hashColumns
}

async function fetchPkHash(pool, predicate, pkColumns, hashColumns) {
  const pkSelect = pkColumns.map((column) => `[${column}]`).join(", ")
  const hashArgs = hashColumns.map(hashExpr).join(", ")
  const query =
    DETERMINISTIC_SESSION_PREFIX +
    `SELECT ${pkSelect}, ` +
    `HASHBYTES('SHA2_256', ISNULL(CONCAT_WS('|', ${hashArgs}), '')) AS rowHash ` +
    `FROM ${qtable(QUALIFIED_TABLE)} WHERE ${predicate}`
  const result = await pool.request().query(query)
  return result.recordset.map((row) => {
    const pkValues = {}
    for (const column of pkColumns) pkValues[column] = row[column]
    const pk = pkColumns.map((column) => String(row[column] ?? "∅")).join("|")
    const raw = row.rowHash
    const rowHash = Buffer.isBuffer(raw) ? raw.toString("hex") : String(raw ?? "")
    return { pk, pkValues, rowHash }
  })
}

function classifyRows(sourceRows, targetRows) {
  const sourceByPk = new Map(sourceRows.map((row) => [row.pk, row]))
  const targetByPk = new Map(targetRows.map((row) => [row.pk, row]))
  const inserts = []
  const updates = []
  const deletes = []
  let unchanged = 0

  for (const [pk, source] of sourceByPk) {
    const target = targetByPk.get(pk)
    if (!target) {
      inserts.push(source)
      continue
    }
    if (source.rowHash === target.rowHash) unchanged += 1
    else updates.push(source)
  }
  for (const [pk, target] of targetByPk) {
    if (!sourceByPk.has(pk)) deletes.push(target)
  }

  return { inserts, updates, deletes, unchanged }
}

async function fetchTargetRowsByPk(pool, pkColumn, scopeColumn, insertCandidates, batchSize = 2000) {
  const rows = []
  for (let offset = 0; offset < insertCandidates.length; offset += batchSize) {
    const batch = insertCandidates.slice(offset, offset + batchSize)
    const literals = batch.map((row) => quoteValue(row.pkValues[pkColumn])).join(", ")
    const query =
      `SELECT [${pkColumn}] AS pk, [${scopeColumn}] AS scopeValue ` +
      `FROM ${qtable(QUALIFIED_TABLE)} WHERE [${pkColumn}] IN (${literals})`
    const result = await pool.request().query(query)
    rows.push(...result.recordset)
  }
  return rows
}

async function detectConflicts(pool, scopeColumn, pkColumns, insertCandidates, contractId, predicate) {
  if (insertCandidates.length === 0) return { count: 0, pkSet: new Set(), sample: [] }
  if (pkColumns.length !== 1) return { count: 0, pkSet: new Set(), sample: [] }
  const pkColumn = pkColumns[0]
  if (!scopeColumn || scopeColumn === pkColumn) return { count: 0, pkSet: new Set(), sample: [] }

  const candidates = insertCandidates.slice(0, 5_000)
  const targetRows = await fetchTargetRowsByPk(pool, pkColumn, scopeColumn, candidates)
  const pkSet = new Set(targetRows.map((row) => String(row.pk ?? "∅")))
  return {
    count: targetRows.length,
    pkSet,
    sample: targetRows.slice(0, 10).map((row) => {
      const pkValue = row.pk
      const scopeValue = row.scopeValue
      return (
        `${pkColumn}=${formatScalar(pkValue)} exists on target with ` +
        `${scopeColumn}=${formatScalar(scopeValue)}, but source claims it under the current sync scope ` +
        `(predicate: ${instantiatePredicate(predicate, contractId)}). ` +
        `Inserting would violate the PK; execute will refuse until target metadata is corrected.`
      )
    })
  }
}

function summariseMode({
  mode,
  predicate,
  sourceRows,
  targetRows,
  classification,
  conflicts,
  sourceTableTotal,
  targetTableTotal
}) {
  const finalInsertCount =
    conflicts.count > 0
      ? classification.inserts.filter((row) => !conflicts.pkSet.has(row.pk)).length
      : classification.inserts.length
  return {
    mode,
    predicate,
    sourceCount: sourceRows.length,
    targetCount: targetRows.length,
    insert: finalInsertCount,
    update: classification.updates.length,
    delete: classification.deletes.length,
    unchanged: classification.unchanged,
    conflicts: conflicts.count,
    sourceMatchesWholeTable: sourceRows.length === sourceTableTotal,
    targetMatchesWholeTable: targetRows.length === targetTableTotal,
    conflictSample: conflicts.sample
  }
}

function printHumanReport(report) {
  console.log(`Source: ${report.source.name} (${report.source.server} / ${report.source.database})`)
  console.log(`Target: ${report.target.name} (${report.target.server} / ${report.target.database})`)
  console.log(`Bundle: ${report.bundlePath}`)
  console.log(`Table: ${report.table}`)
  console.log("")

  for (const contract of report.contracts) {
    console.log(`Contract ${contract.contractId}`)
    console.log(`  source contract exists: ${contract.sourceContractExists}`)
    console.log(`  target contract exists: ${contract.targetContractExists}`)
    console.log(`  source table total: ${contract.sourceTableTotal}`)
    console.log(`  target table total: ${contract.targetTableTotal}`)
    for (const mode of contract.modes) {
      console.log(`  ${mode.mode}`)
      console.log(`    source rows: ${mode.sourceCount}`)
      console.log(`    target rows: ${mode.targetCount}`)
      console.log(
        `    insert/update/delete/eq: ${mode.insert}/${mode.update}/${mode.delete}/${mode.unchanged}`
      )
      console.log(`    conflicts: ${mode.conflicts}`)
      console.log(`    source==full table: ${mode.sourceMatchesWholeTable}`)
      console.log(`    target==full table: ${mode.targetMatchesWholeTable}`)
      console.log(`    predicate: ${mode.predicate}`)
      for (const sample of mode.conflictSample) {
        console.log(`    conflict sample: ${sample}`)
      }
    }
    console.log("")
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      source: { type: "string" },
      target: { type: "string" },
      contract: { type: "string", multiple: true },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" }
    },
    allowPositionals: false
  })

  if (values.help) usage()

  const sourceName = values.source ?? "uat"
  const targetName = values.target ?? "dev"
  const contractIds = (values.contract?.length ? values.contract : DEFAULT_CONTRACT_IDS.map(String)).map(
    (value) => {
      const parsed = Number(value)
      if (!Number.isInteger(parsed)) usage(`Invalid --contract value: ${value}`)
      return parsed
    }
  )

  const repoRoot = resolve(new URL("..", import.meta.url).pathname)
  const { predicate: publishedPredicate, scopeColumn, bundlePath } = readPublishedPredicate(repoRoot)
  const configuredConnections = loadAllMssqlDatabaseConfigs()
  const sourceConnection = resolveMssqlConfig(configuredConnections, sourceName)
  const targetConnection = resolveMssqlConfig(configuredConnections, targetName)

  const sourcePool = new sql.ConnectionPool(sourceConnection.config)
  const targetPool = new sql.ConnectionPool(targetConnection.config)

  await sourcePool.connect()
  await targetPool.connect()

  try {
    const [pkColumns, hashColumns, sourceTableTotal, targetTableTotal] = await Promise.all([
      fetchPkColumns(sourcePool, QUALIFIED_TABLE),
      fetchTableColumns(sourcePool, QUALIFIED_TABLE),
      fetchTableTotal(sourcePool),
      fetchTableTotal(targetPool)
    ])

    const report = {
      source: {
        name: sourceConnection.name,
        server: sourceConnection.config.server,
        database: sourceConnection.config.database
      },
      target: {
        name: targetConnection.name,
        server: targetConnection.config.server,
        database: targetConnection.config.database
      },
      table: QUALIFIED_TABLE,
      bundlePath,
      contracts: []
    }

    for (const contractId of contractIds) {
      const [sourceContractExists, targetContractExists] = await Promise.all([
        fetchContractExists(sourcePool, contractId),
        fetchContractExists(targetPool, contractId)
      ])

      const modes = []
      for (const [mode, predicate] of [
        ["legacy", LEGACY_PREDICATE],
        ["published", publishedPredicate]
      ]) {
        const scopedPredicate = instantiatePredicate(predicate, contractId)
        const [sourceRows, targetRows] = await Promise.all([
          fetchPkHash(sourcePool, scopedPredicate, pkColumns, hashColumns),
          fetchPkHash(targetPool, scopedPredicate, pkColumns, hashColumns)
        ])
        const classification = classifyRows(sourceRows, targetRows)
        const conflicts = await detectConflicts(
          targetPool,
          scopeColumn,
          pkColumns,
          classification.inserts,
          contractId,
          predicate
        )
        modes.push(
          summariseMode({
            mode,
            predicate: scopedPredicate,
            sourceRows,
            targetRows,
            classification,
            conflicts,
            sourceTableTotal,
            targetTableTotal
          })
        )
      }

      report.contracts.push({
        contractId,
        sourceContractExists,
        targetContractExists,
        sourceTableTotal,
        targetTableTotal,
        modes
      })
    }

    if (values.json) console.log(JSON.stringify(report, null, 2))
    else printHumanReport(report)
  } finally {
    await Promise.allSettled([sourcePool.close(), targetPool.close()])
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
