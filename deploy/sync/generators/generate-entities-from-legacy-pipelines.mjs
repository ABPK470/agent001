#!/usr/bin/env node

import sql from "mssql"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { buildCatalogIndexFromQueryResults, deriveSyncDefinitions, extractSyncObjectCalls } from "../helpers/legacy-entity-derivation.mjs"
import { parsePipelineIds } from "../helpers/legacy-flow-template-derivation.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, "../../..")
const DEFAULT_OUTPUT_DIR = "deploy/sync/artifacts/entities"

main().catch((error) => {
  console.error(`ERROR ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const pipelineIds = parsePipelineIds(options.pipelineIds)
  const evidence = await loadEvidence(options.connection)
  validateEvidence(pipelineIds, evidence)
  const catalogIndex = await loadCatalogIndex(options.connection)

  const outputDir = resolve(ROOT, options.outputDir)
  mkdirSync(outputDir, { recursive: true })
  const generatedAt = options.generatedAt ?? new Date().toISOString()
  const definitions = deriveSyncDefinitions(
    evidence.pipelines.filter((pipeline) => pipelineIds.includes(Number(pipeline.pipelineId))),
    catalogIndex,
    generatedAt,
  )

  for (const definition of definitions) {
    const outputPath = resolve(outputDir, `${definition.id}.json`)
    if (existsSync(outputPath) && !options.force) {
      fail(`Refusing to overwrite existing file without --force: ${relative(ROOT, outputPath)}`)
    }
    writeFileSync(outputPath, `${JSON.stringify(definition, null, 2)}\n`, "utf-8")
    console.log(`Wrote ${relative(ROOT, outputPath)}`)
  }
}

function parseArgs(argv) {
  const options = {
    pipelineIds: null,
    connection: null,
    outputDir: DEFAULT_OUTPUT_DIR,
    generatedAt: null,
    force: false,
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    switch (arg) {
      case "--pipeline-ids":
        options.pipelineIds = argv[++index] ?? null
        break
      case "--connection":
        options.connection = argv[++index] ?? null
        break
      case "--output-dir":
        options.outputDir = argv[++index] ?? options.outputDir
        break
      case "--generated-at":
        options.generatedAt = argv[++index] ?? null
        break
      case "--force":
        options.force = true
        break
      default:
        fail(`Unknown argument: ${arg}`)
    }
  }

  return options
}

async function loadEvidence(connectionName) {
  const pool = await connectMssql(connectionName)
  try {
    return await fetchPipelineEvidence(pool)
  } finally {
    await pool.close()
  }
}

function validateEvidence(pipelineIds, evidence) {
  const pipelineMap = new Map((evidence.pipelines ?? []).map((pipeline) => [Number(pipeline.pipelineId), pipeline]))
  for (const pipelineId of pipelineIds) {
    const pipeline = pipelineMap.get(pipelineId)
    if (!pipeline) fail(`Pipeline ${pipelineId} not found in evidence.`)
    if (!Array.isArray(pipeline.activities) || pipeline.activities.length === 0) {
      fail(`Pipeline ${pipelineId} has no ordered activities in evidence.`)
    }
    const sorted = [...pipeline.activities].sort((left, right) => Number(left.sequence) - Number(right.sequence))
    if (JSON.stringify(sorted) !== JSON.stringify(pipeline.activities)) {
      fail(`Pipeline ${pipelineId} activities are not ordered by sequence.`)
    }
    if (!Array.isArray(pipeline.syncObjectCalls) || pipeline.syncObjectCalls.length === 0) {
      fail(`Pipeline ${pipelineId} has no parsed uspSyncObjectTran call evidence.`)
    }
  }
}

function parseMssqlConfigs() {
  const databasesJson = process.env["MSSQL_DATABASES"]
  if (databasesJson) {
    const raw = JSON.parse(databasesJson)
    if (!Array.isArray(raw) || raw.length === 0) fail("MSSQL_DATABASES must be a non-empty JSON array.")
    return raw.map((entry) => ({
      name: entry.name,
      config: {
        server: entry.host,
        port: entry.port ?? 1433,
        user: entry.user ?? "sa",
        password: entry.password ?? "",
        database: entry.database ?? "master",
        domain: entry.domain,
        options: {
          encrypt: entry.encrypt !== false,
          trustServerCertificate: entry.trustServerCertificate !== false,
        },
      },
    }))
  }

  const server = process.env["MSSQL_HOST"] || process.env["MSSQL_SERVER"]
  if (!server) fail("MSSQL not configured. Set MSSQL_DATABASES or MSSQL_HOST/MSSQL_SERVER.")
  return [{
    name: "default",
    config: {
      server,
      port: Number(process.env["MSSQL_PORT"] ?? 1433),
      user: process.env["MSSQL_USER"] ?? "sa",
      password: process.env["MSSQL_PASSWORD"] ?? "",
      database: process.env["MSSQL_DATABASE"] ?? "master",
      domain: process.env["MSSQL_DOMAIN"] || undefined,
      options: {
        encrypt: process.env["MSSQL_ENCRYPT"] !== "false",
        trustServerCertificate: process.env["MSSQL_TRUST_CERT"] !== "false",
      },
    },
  }]
}

async function connectMssql(connectionName) {
  const configs = parseMssqlConfigs()
  const defaultName = process.env["MSSQL_DEFAULT_CONNECTION"] ?? configs[0].name
  const selected = configs.find((entry) => entry.name === (connectionName ?? defaultName))
  if (!selected) fail(`Unknown MSSQL connection ${connectionName ?? defaultName}. Available: ${configs.map((entry) => entry.name).join(", ")}`)
  const pool = new sql.ConnectionPool({
    ...selected.config,
    options: {
      encrypt: true,
      trustServerCertificate: true,
      ...(selected.config.options ?? {}),
    },
    requestTimeout: 120_000,
    connectionTimeout: 15_000,
  })
  await pool.connect()
  return pool
}

async function fetchPipelineEvidence(pool) {
  const pipelineIds = parsePipelineIds(null).join(", ")
  const pipelines = await pool.request().query(`
    SELECT pipelineId, name
    FROM core.Pipeline
    WHERE pipelineId IN (${pipelineIds})
    ORDER BY pipelineId
  `)
  const activities = await pool.request().query(`
    SELECT
      pipelineId,
      sequence,
      name AS activityName,
      JSON_VALUE(properties, '$.storedProcedure') AS storedProcedure
    FROM core.Activity
    WHERE pipelineId IN (${pipelineIds})
    ORDER BY pipelineId, sequence
  `)
  const entrySprocs = [...new Set(activities.recordset.map((activity) => activity.storedProcedure).filter((value) => value && /^core\.uspSync.*ObjectsTran$/i.test(value)))]
  const procBodies = new Map()
  for (const entrySproc of entrySprocs) {
    const definition = await pool.request().input("procName", sql.NVarChar, entrySproc).query(`SELECT OBJECT_DEFINITION(OBJECT_ID(@procName)) AS body`)
    procBodies.set(entrySproc, definition.recordset[0]?.body ?? "")
  }
  return {
    pipelines: pipelines.recordset.map((pipeline) => ({
      ...pipeline,
      activities: activities.recordset.filter((activity) => Number(activity.pipelineId) === Number(pipeline.pipelineId)),
      syncObjectCalls: extractSyncObjectCalls(procBodies.get(activities.recordset.find((activity) => Number(activity.pipelineId) === Number(pipeline.pipelineId) && activity.storedProcedure && /^core\.uspSync.*ObjectsTran$/i.test(activity.storedProcedure))?.storedProcedure ?? "") ?? ""),
    })),
  }
}

async function loadCatalogIndex(connectionName) {
  const pool = await connectMssql(connectionName)
  try {
    const columns = await pool.request().query(`
      WITH pk_cols AS (
        SELECT ic.object_id, ic.column_id
        FROM sys.indexes i
        JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        WHERE i.is_primary_key = 1
      )
      SELECT
        s.name AS schemaName,
        t.name AS tableName,
        c.name AS columnName,
        CASE WHEN pk_cols.column_id IS NULL THEN 0 ELSE 1 END AS isPrimaryKey
      FROM sys.columns c
      JOIN sys.tables t ON t.object_id = c.object_id
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      LEFT JOIN pk_cols ON pk_cols.object_id = c.object_id AND pk_cols.column_id = c.column_id
      WHERE s.name IN ('core','coreArchive','gate','gateArchive','master')
      ORDER BY s.name, t.name, c.column_id
    `)
    const foreignKeys = await pool.request().query(`
      SELECT
        rs.name AS parentSchema,
        rt.name AS parentTable,
        rc.name AS parentColumn,
        ps.name AS childSchema,
        pt.name AS childTable,
        pc.name AS childColumn
      FROM sys.foreign_key_columns fkc
      JOIN sys.tables pt ON pt.object_id = fkc.parent_object_id
      JOIN sys.schemas ps ON ps.schema_id = pt.schema_id
      JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
      JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id
      JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
      JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
      WHERE ps.name IN ('core','coreArchive','gate','gateArchive','master')
        AND rs.name IN ('core','coreArchive','gate','gateArchive','master')
    `)
    return buildCatalogIndexFromQueryResults(columns.recordset, foreignKeys.recordset)
  } finally {
    await pool.close()
  }
}

function fail(message) {
  console.error(`ERROR ${message}`)
  process.exit(1)
}