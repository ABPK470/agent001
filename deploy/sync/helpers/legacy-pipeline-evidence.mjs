/**
 * Shared MyMI pipeline evidence — single fetch used by all sync bootstrap generators.
 *
 * Ground truth: core.Pipeline + core.Activity (sequence, name, action, properties JSON).
 */

import sql from "mssql"
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULT_SPECS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/legacy-activity-sync-specs.json"
)

export function loadLegacyActivitySyncSpecs(specsPath = DEFAULT_SPECS_PATH) {
  if (!existsSync(specsPath)) return {}
  const parsed = JSON.parse(readFileSync(specsPath, "utf-8"))
  return parsed.specs ?? parsed
}

export const DEFAULT_PIPELINE_IDS = [692, 780, 788, 791, 792, 798]

const EXCLUDED_STORED_PROCEDURES = new Set(["core.uspGetPipelineIdForContract"])

/** MyMI internal activities use action values starting with "_"; they are out of sync scope. */
export function isExcludedPipelineAction(action) {
  return typeof action === "string" && action.startsWith("_")
}

/** Some legacy helper sprocs only resolve runtime bindings and do not surface as sync flow steps. */
export function isExcludedPipelineStoredProcedure(storedProcedure) {
  return typeof storedProcedure === "string" && EXCLUDED_STORED_PROCEDURES.has(storedProcedure)
}

export function readActivityAction(activity) {
  if (activity?.action != null && activity.action !== "") return activity.action
  const props = activity?.properties
  if (!props) return null
  if (typeof props === "object" && props.action != null) return props.action
  if (typeof props === "string") {
    try {
      const parsed = JSON.parse(props)
      return parsed.action ?? null
    } catch {
      return null
    }
  }
  return null
}

export function isScopedPipelineActivity(activity) {
  return (
    !isExcludedPipelineAction(readActivityAction(activity)) &&
    !isExcludedPipelineStoredProcedure(activity?.storedProcedure ?? null)
  )
}

export function scopedPipelineActivities(activities) {
  return (activities ?? []).filter(isScopedPipelineActivity)
}

export function parsePipelineIds(rawValue) {
  if (!rawValue || String(rawValue).trim() === "") {
    return [...DEFAULT_PIPELINE_IDS]
  }
  return String(rawValue)
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value))
}

export function parseMssqlConfigs() {
  const databasesJson = process.env["MSSQL_DATABASES"]
  if (databasesJson) {
    const raw = JSON.parse(databasesJson)
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error("MSSQL_DATABASES must be a non-empty JSON array.")
    }
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
          trustServerCertificate: entry.trustServerCertificate !== false
        }
      }
    }))
  }

  const server = process.env["MSSQL_HOST"] || process.env["MSSQL_SERVER"]
  if (!server) {
    throw new Error(
      "MSSQL not configured. Set MSSQL_DATABASES or MSSQL_HOST/MSSQL_SERVER, or use --evidence-file."
    )
  }
  return [
    {
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
          trustServerCertificate: process.env["MSSQL_TRUST_CERT"] !== "false"
        }
      }
    }
  ]
}

export async function connectMssql(connectionName) {
  const configs = parseMssqlConfigs()
  const defaultName = process.env["MSSQL_DEFAULT_CONNECTION"] ?? configs[0].name
  const selected = configs.find((entry) => entry.name === (connectionName ?? defaultName))
  if (!selected) {
    throw new Error(
      `Unknown MSSQL connection ${connectionName ?? defaultName}. Available: ${configs.map((entry) => entry.name).join(", ")}`
    )
  }
  const pool = new sql.ConnectionPool({
    ...selected.config,
    options: {
      encrypt: true,
      trustServerCertificate: true,
      ...(selected.config.options ?? {})
    },
    requestTimeout: 120_000,
    connectionTimeout: 15_000
  })
  await pool.connect()
  return pool
}

/**
 * Fetch ordered pipeline activities with full properties JSON from MyMI.
 * Optional syncObjectCalls when extractSyncObjectCalls is provided (entity bootstrap).
 */
export async function fetchPipelineEvidence(pool, options = {}) {
  const pipelineIds = parsePipelineIds(options.pipelineIds).join(", ")
  const pipelines = await pool.request().query(`
    SELECT pipelineId, name
    FROM core.Pipeline
    WHERE pipelineId IN (${pipelineIds})
    ORDER BY pipelineId
  `)
  const activities = await pool.request().query(`
    SELECT
      activityId,
      pipelineId,
      sequence,
      name AS activityName,
      action,
      properties,
      JSON_VALUE(properties, '$.storedProcedure') AS storedProcedure
    FROM core.Activity
    WHERE pipelineId IN (${pipelineIds})
    ORDER BY pipelineId, sequence
  `)

  const entrySprocs = [
    ...new Set(
      activities.recordset
        .map((activity) => activity.storedProcedure)
        .filter((value) => value && /^core\.uspSync.*ObjectsTran$/i.test(value))
    )
  ]

  const procBodies = new Map()
  if (typeof options.extractSyncObjectCalls === "function") {
    for (const entrySproc of entrySprocs) {
      const definition = await pool
        .request()
        .input("procName", sql.NVarChar, entrySproc)
        .query(`SELECT OBJECT_DEFINITION(OBJECT_ID(@procName)) AS body`)
      procBodies.set(entrySproc, definition.recordset[0]?.body ?? "")
    }
  }

  return {
    pipelines: pipelines.recordset.map((pipeline) => {
      const pipelineActivities = scopedPipelineActivities(
        activities.recordset
          .filter((activity) => Number(activity.pipelineId) === Number(pipeline.pipelineId))
          .map(normalizeActivityRow)
      )

      const entryActivity = pipelineActivities.find(
        (activity) =>
          typeof activity.storedProcedure === "string" &&
          /^core\.uspSync.*ObjectsTran$/i.test(activity.storedProcedure)
      )
      const syncObjectCalls =
        typeof options.extractSyncObjectCalls === "function" && entryActivity?.storedProcedure
          ? options.extractSyncObjectCalls(procBodies.get(entryActivity.storedProcedure) ?? "")
          : undefined

      return {
        pipelineId: pipeline.pipelineId,
        name: pipeline.name,
        activities: pipelineActivities,
        ...(syncObjectCalls ? { syncObjectCalls } : {})
      }
    })
  }
}

function normalizeActivityRow(row) {
  return {
    activityId: row.activityId,
    pipelineId: row.pipelineId,
    sequence: row.sequence,
    activityName: row.activityName,
    action: row.action ?? null,
    storedProcedure: row.storedProcedure ?? null,
    properties: row.properties ?? null
  }
}

export function validatePipelineEvidence(pipelineIds, evidence, { requireSyncObjectCalls = false } = {}) {
  const pipelineMap = new Map(
    (evidence.pipelines ?? []).map((pipeline) => [Number(pipeline.pipelineId), pipeline])
  )
  for (const pipelineId of pipelineIds) {
    const pipeline = pipelineMap.get(pipelineId)
    if (!pipeline) throw new Error(`Pipeline ${pipelineId} not found in evidence.`)
    if (!Array.isArray(pipeline.activities) || pipeline.activities.length === 0) {
      throw new Error(`Pipeline ${pipelineId} has no ordered activities in evidence.`)
    }
    const sorted = [...pipeline.activities].sort(
      (left, right) => Number(left.sequence) - Number(right.sequence)
    )
    if (JSON.stringify(sorted) !== JSON.stringify(pipeline.activities)) {
      throw new Error(`Pipeline ${pipelineId} activities are not ordered by sequence.`)
    }
    if (
      requireSyncObjectCalls &&
      (!Array.isArray(pipeline.syncObjectCalls) || pipeline.syncObjectCalls.length === 0)
    ) {
      throw new Error(`Pipeline ${pipelineId} has no parsed uspSyncObjectTran call evidence.`)
    }
  }
}
