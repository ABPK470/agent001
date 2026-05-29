#!/usr/bin/env node

import sql from "mssql"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { buildFlowTemplateCatalogFromPipelines, parsePipelineIds } from "../helpers/legacy-flow-template-derivation.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, "../../..")
const DEFAULT_OUTPUT_PATH = "deploy/sync/artifacts/flow-templates.json"

main().catch((error) => {
  console.error(`ERROR ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const pipelineIds = parsePipelineIds(options.pipelineIds)
  const evidence = await loadEvidence(options)
  validateEvidence(pipelineIds, evidence)
  const selectedPipelines = evidence.pipelines.filter((pipeline) => pipelineIds.includes(Number(pipeline.pipelineId)))

  const outputPath = resolve(ROOT, options.output)
  if (existsSync(outputPath) && !options.force) {
    fail(`Refusing to overwrite existing file without --force: ${relative(ROOT, outputPath)}`)
  }
  mkdirSync(dirname(outputPath), { recursive: true })
  const catalog = buildFlowTemplateCatalogFromPipelines(selectedPipelines)
  writeFileSync(outputPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf-8")
  console.log(`Wrote ${relative(ROOT, outputPath)}`)
}

function parseArgs(argv) {
  const options = {
    pipelineIds: null,
    connection: null,
    evidenceFile: null,
    output: DEFAULT_OUTPUT_PATH,
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
      case "--evidence-file":
        options.evidenceFile = argv[++index] ?? null
        break
      case "--output":
        options.output = argv[++index] ?? options.output
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

async function loadEvidence(options) {
  if (options.evidenceFile) {
    return JSON.parse(readFileSync(resolve(ROOT, options.evidenceFile), "utf-8"))
  }
  const pool = await connectMssql(options.connection)
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
  if (!server) fail("MSSQL not configured. Set MSSQL_DATABASES or MSSQL_HOST/MSSQL_SERVER, or use --evidence-file.")
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
  return {
    pipelines: pipelines.recordset.map((pipeline) => ({
      ...pipeline,
      activities: activities.recordset.filter((activity) => Number(activity.pipelineId) === Number(pipeline.pipelineId)),
    })),
  }
}

function fail(message) {
  console.error(`ERROR ${message}`)
  process.exit(1)
}