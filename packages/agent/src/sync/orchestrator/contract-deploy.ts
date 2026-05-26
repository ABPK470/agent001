/**
 * Contract deployment — calls target-local procedures directly.
 *
 * The legacy sync system routed contract deployment through thin
 * `uspSync*` wrappers on the source that dispatched to target-local
 * worker procs via linked server. Since we already hold a direct
 * `tgtPool` connection to the target, we call the workers directly
 * with typed parameters and standardised result parsing.
 *
 * Design principles:
 *   - **No linked server** — direct pool execution via `trackedExecute`.
 *   - **Configurable** — proc names live in a config object that can
 *     be overridden per environment or test.
 *   - **Maintainable** — the DB team owns the proc implementations;
 *     this module is a thin, typed invocation layer.
 *   - **Observable** — every call flows through `trackedExecute` so it
 *     appears in sync telemetry.
 *
 * @module
 */

import sqlMod, { type ConnectionPool, type IProcedureResult, type IRecordSet } from "mssql"
import type { AgentHost } from "../../application/shell/runtime.js"
import type { SyncSqlTraceContext } from "../sync-events.js"
import { trackedExecute, trackedQuery } from "./db-helpers.js"

// ────────────────────────────────────────────────────────────
// Configuration
// ────────────────────────────────────────────────────────────

/** Procedure name mapping — override for non-standard targets. */
export interface ContractProcConfig {
  auditRunCheck: string
  setContractLock: string
  runContractDeploymentScripts: string
  undeployMarkedContract: string
  createDataset: string
  createDatasetFKs: string
  deployETL: string
  deployRoutine: string
}

export const DEFAULT_PROCS: Readonly<ContractProcConfig> = {
  auditRunCheck: "core.uspAuditRunCheck",
  setContractLock: "core.uspSetContractLock",
  runContractDeploymentScripts: "core.uspRunContractDeploymentScripts",
  undeployMarkedContract: "core.uspUndeployMarkedContract",
  createDataset: "core.uspCreateDataset",
  createDatasetFKs: "core.uspCreateDatasetFKs",
  deployETL: "core.uspDeployETL2CustomTransformation",
  deployRoutine: "core.uspDeployRoutine",
}

export type DatasetType = "stage" | "archive" | "list" | "dim" | "fact"

// ────────────────────────────────────────────────────────────
// Result parsing
// ────────────────────────────────────────────────────────────

/**
 * All target worker procs return result sets with a status/message
 * pattern. This interface captures the common shape.
 */
export interface DeployStepResult {
  status: string
  message: string
  errors: DeployStepError[]
}

export interface DeployStepError {
  objectName?: string
  errorLine?: string
  errorMessage: string
}

/**
 * Parse a result from a worker proc execution.
 *
 * Worker procs return one or more recordsets with varying column names
 * but a consistent `status` + `message` / `errorMessage` pattern.
 * We normalise that into a single `DeployStepResult`.
 */
function parseWorkerResult(result: IProcedureResult<unknown>, procLabel: string): DeployStepResult {
  const errors: DeployStepError[] = []
  let status = "success"
  let message = ""

  for (const rs of (result.recordsets ?? []) as IRecordSet<Record<string, unknown>>[]) {
    for (const row of rs) {
      const rowStatus = String(row["status"] ?? row["Status"] ?? "").toLowerCase()
      const rowMessage = String(row["message"] ?? row["errorMessage"] ?? row["Message"] ?? "")

      if (rowStatus === "error") {
        status = "error"
        errors.push({
          objectName: row["objectName"] ? String(row["objectName"]) : row["datasetName"] ? String(row["datasetName"]) : undefined,
          errorLine: row["errorLine"] ? String(row["errorLine"]) : undefined,
          errorMessage: rowMessage || row["errorMessage"] ? String(row["errorMessage"] ?? rowMessage) : "Unknown error",
        })
      } else if (!message && rowMessage) {
        message = rowMessage
      }

      if (rowStatus === "warning" && status !== "error") {
        status = "warning"
      }
    }
  }

  if (!message) message = `${procLabel} completed with status: ${status}`

  return { status, message, errors }
}

/**
 * Throw if the result contains hard errors. Warnings are returned
 * without throwing so the caller can decide how to handle them.
 */
function assertNoErrors(result: DeployStepResult, stepLabel: string): void {
  if (result.status === "error" && result.errors.length > 0) {
    const detail = result.errors
      .map((e) => [e.objectName, e.errorLine ? `line ${e.errorLine}` : null, e.errorMessage].filter(Boolean).join(": "))
      .join("; ")
    throw new Error(`${stepLabel} failed: ${detail}`)
  }
}

// ────────────────────────────────────────────────────────────
// Contract name resolution
// ────────────────────────────────────────────────────────────

/**
 * Resolve contractId → contractName on the target database.
 *
 * The pipeline orchestrator works with contractId (numeric), but
 * the target worker procs accept contractName (varchar). This does
 * a single cheap lookup against `core.Contract`.
 */
export async function resolveContractName(
  host: AgentHost,
  pool: ConnectionPool,
  contractId: number,
  connection: string,
  syncTrace: SyncSqlTraceContext | null = null,
): Promise<string> {
  const req = pool.request()
  req.input("contractId", sqlMod.Int, contractId)
  const result = await trackedQuery<{ contractName: string }>(
    host,
    req,
    "SELECT [name] AS contractName FROM core.Contract WHERE contractId = @contractId",
    `contractDeploy.resolveContractName(${contractId})`,
    connection,
    syncTrace,
  )
  const row = result.recordset?.[0]
  if (!row?.contractName) {
    throw new Error(`Contract with contractId ${contractId} does not exist on target.`)
  }
  return row.contractName
}

// ────────────────────────────────────────────────────────────
// Deployment step functions
// ────────────────────────────────────────────────────────────

/**
 * Undeploy a contract that is marked for deletion.
 *
 * Calls `core.uspUndeployMarkedContract` on target. The proc handles
 * the no-op cases internally (not marked for deletion, no changes, etc).
 */
export async function undeployMarkedContract(
  host: AgentHost,
  pool: ConnectionPool,
  contractId: number,
  connection: string,
  syncTrace: SyncSqlTraceContext | null = null,
  procs: ContractProcConfig = DEFAULT_PROCS,
): Promise<DeployStepResult> {
  const req = pool.request()
  req.input("contractId", sqlMod.Int, contractId)

  const result = await trackedExecute(
    host,
    req,
    procs.undeployMarkedContract,
    `contractDeploy.undeploy(${contractId})`,
    connection,
    syncTrace,
  )

  const parsed = parseWorkerResult(result, "undeploy")
  assertNoErrors(parsed, `undeploy(contractId=${contractId})`)
  return parsed
}

/**
 * Create or alter a dataset (table/view) for a contract.
 *
 * Calls `core.uspCreateDataset` on target for the given dataset type.
 * The proc is idempotent — it creates the table if missing, or alters
 * it to match current metadata if it already exists.
 */
export async function createDataset(
  host: AgentHost,
  pool: ConnectionPool,
  _contractId: number,
  contractName: string,
  type: DatasetType,
  connection: string,
  syncTrace: SyncSqlTraceContext | null = null,
  procs: ContractProcConfig = DEFAULT_PROCS,
): Promise<DeployStepResult> {
  const req = pool.request()
  req.input("ContractName", sqlMod.VarChar(128), contractName)
  req.input("type", sqlMod.VarChar(50), type)
  req.input("isDebug", sqlMod.Bit, false)
  req.input("isExtraLogged", sqlMod.Bit, false)

  const result = await trackedExecute(
    host,
    req,
    procs.createDataset,
    `contractDeploy.createDataset(${contractName},${type})`,
    connection,
    syncTrace,
  )

  const parsed = parseWorkerResult(result, `createDataset(${type})`)
  assertNoErrors(parsed, `createDataset(${contractName},${type})`)
  return parsed
}

/**
 * Reconcile foreign key constraints for a contract's dataset.
 *
 * Calls `core.uspCreateDatasetFKs` on target. The proc compares
 * desired FKs (from `core.DatasetColumn.lookupDatasetId`) with
 * existing `sys.foreign_keys` and creates/drops/enables/disables
 * as needed.
 */
export async function createDatasetFKs(
  host: AgentHost,
  pool: ConnectionPool,
  contractName: string,
  connection: string,
  syncTrace: SyncSqlTraceContext | null = null,
  procs: ContractProcConfig = DEFAULT_PROCS,
): Promise<DeployStepResult> {
  const req = pool.request()
  req.input("contractName", sqlMod.VarChar(100), contractName)
  req.input("isDebug", sqlMod.Bit, false)
  // NULL = reconcile all FKs for this contract (not scoped to a specific referenced table)
  req.input("referencedSchemaName", sqlMod.VarChar(100), null)
  req.input("referencedTableName", sqlMod.VarChar(100), null)
  req.input("isExtraLogged", sqlMod.Bit, false)

  const result = await trackedExecute(
    host,
    req,
    procs.createDatasetFKs,
    `contractDeploy.createDatasetFKs(${contractName})`,
    connection,
    syncTrace,
  )

  const parsed = parseWorkerResult(result, "createDatasetFKs")
  assertNoErrors(parsed, `createDatasetFKs(${contractName})`)
  return parsed
}

/**
 * Deploy ETL transform and publish objects for a contract.
 *
 * Calls `core.uspDeployETL2CustomTransformation` on target. The proc
 * parses `controlFlow.transform[]` and `controlFlow.publish[]` from
 * the contract metadata and creates/updates the corresponding database
 * objects (stored procs, views, functions, triggers) and `core.Dataset`
 * entries.
 */
export async function deployETL(
  host: AgentHost,
  pool: ConnectionPool,
  contractName: string,
  connection: string,
  syncTrace: SyncSqlTraceContext | null = null,
  procs: ContractProcConfig = DEFAULT_PROCS,
): Promise<DeployStepResult> {
  const req = pool.request()
  req.input("contractName", sqlMod.VarChar(500), contractName)
  req.input("isDebug", sqlMod.Bit, false)

  const result = await trackedExecute(
    host,
    req,
    procs.deployETL,
    `contractDeploy.deployETL(${contractName})`,
    connection,
    syncTrace,
  )

  const parsed = parseWorkerResult(result, "deployETL")
  assertNoErrors(parsed, `deployETL(${contractName})`)
  return parsed
}

/**
 * Deploy trigger routines for a contract.
 *
 * Calls `core.uspDeployRoutine` on target. The proc parses
 * `controlFlow.routine[]` from contract metadata and reconciles
 * triggers (create/drop/enable/disable) on the target dataset table.
 */
export async function deployRoutine(
  host: AgentHost,
  pool: ConnectionPool,
  contractName: string,
  connection: string,
  syncTrace: SyncSqlTraceContext | null = null,
  procs: ContractProcConfig = DEFAULT_PROCS,
): Promise<DeployStepResult> {
  const req = pool.request()
  req.input("contractName", sqlMod.VarChar(500), contractName)
  req.input("isExtraLogged", sqlMod.Bit, false)
  req.input("isDebug", sqlMod.Bit, false)

  const result = await trackedExecute(
    host,
    req,
    procs.deployRoutine,
    `contractDeploy.deployRoutine(${contractName})`,
    connection,
    syncTrace,
  )

  const parsed = parseWorkerResult(result, "deployRoutine")
  assertNoErrors(parsed, `deployRoutine(${contractName})`)
  return parsed
}

// ────────────────────────────────────────────────────────────
// Audit check
// ────────────────────────────────────────────────────────────

type AuditAction = "deployDate" | "syncDate" | "runOrNot" | "syncOrNot"

/**
 * Run an audit gate check or stamp a date on a contract/entity.
 *
 * Calls `core.uspAuditRunCheck` on the given pool (source or target).
 * The proc handles all four actions internally:
 *   - `syncOrNot` / `runOrNot` — returns status=success|stop
 *   - `deployDate` / `syncDate` — stamps the date, returns success
 */
export async function runAuditCheckDirect(
  host: AgentHost,
  pool: ConnectionPool,
  params: { schema?: string; objType: string; id: string | number; action: AuditAction },
  connection: string,
  syncTrace: SyncSqlTraceContext | null = null,
  procs: ContractProcConfig = DEFAULT_PROCS,
): Promise<{ status: string; message: string } | null> {
  const req = pool.request()
  req.input("id", sqlMod.VarChar(10), String(params.id))
  req.input("objType", sqlMod.VarChar(500), params.objType)
  req.input("action", sqlMod.VarChar(50), params.action)
  req.input("schema", sqlMod.VarChar(100), params.schema ?? "core")

  const result = await trackedExecute(
    host,
    req,
    procs.auditRunCheck,
    `contractDeploy.auditRunCheck(${params.action}/${params.objType}/${params.id})`,
    connection,
    syncTrace,
  )

  const row = (result.recordsets?.[0] as IRecordSet<{ status: string; message: string }> | undefined)?.[0]
  return row ? { status: row.status, message: row.message } : null
}

// ────────────────────────────────────────────────────────────
// Contract lock
// ────────────────────────────────────────────────────────────

/**
 * Lock or unlock a contract.
 *
 * Calls `core.uspSetContractLock` on target. The proc updates
 * `core.Contract.isLocked` and returns status/message.
 */
export async function setContractLockDirect(
  host: AgentHost,
  pool: ConnectionPool,
  contractId: number,
  isLocked: boolean,
  connection: string,
  syncTrace: SyncSqlTraceContext | null = null,
  procs: ContractProcConfig = DEFAULT_PROCS,
): Promise<void> {
  const req = pool.request()
  req.input("contractId", sqlMod.Int, contractId)
  req.input("isLocked", sqlMod.Bit, isLocked)

  await trackedExecute(
    host,
    req,
    procs.setContractLock,
    `contractDeploy.setContractLock(${contractId},${isLocked ? 1 : 0})`,
    connection,
    syncTrace,
  )
}

// ────────────────────────────────────────────────────────────
// Pre/post deployment scripts
// ────────────────────────────────────────────────────────────

/**
 * Run pre- or post-deployment scripts for a contract.
 *
 * Calls `core.uspRunContractDeploymentScripts` on target. The proc
 * reads the `controlFlow.preScript[]` or `controlFlow.postScript[]`
 * array from the contract metadata and executes each script.
 */
export async function runContractDeploymentScriptsDirect(
  host: AgentHost,
  pool: ConnectionPool,
  contractName: string,
  action: "Run preScript" | "Run postScript",
  connection: string,
  syncTrace: SyncSqlTraceContext | null = null,
  procs: ContractProcConfig = DEFAULT_PROCS,
): Promise<void> {
  const req = pool.request()
  req.input("contractName", sqlMod.VarChar(100), contractName)
  req.input("action", sqlMod.VarChar(100), action)
  req.input("isDebug", sqlMod.Bit, false)

  await trackedExecute(
    host,
    req,
    procs.runContractDeploymentScripts,
    `contractDeploy.runDeploymentScripts(${contractName}/${action})`,
    connection,
    syncTrace,
  )
}
