/**
 * Connector write capability — the hard ceiling below governance.
 *
 * Governance (policy allow / require_approval / env access) answers whether a
 * run may *attempt* a write-shaped action. Connector `writeEnabled` answers
 * whether the linked database connection may *mutate* real objects.
 *
 * Both must pass. Approving a policy never flips the connector latch.
 * Canonical operator copy lives here so agent, sync, server, and UI stay aligned.
 */

/** Validation / trace code emitted by query_mssql when the connector is read-only. */
export const WRITE_DISABLED_VALIDATION_CODE = "write_disabled" as const

/** Human label for `write_disabled` — capability, not governance. */
export const WRITE_DISABLED_LABEL = "connector read-only"

/** query_mssql / export path when writeEnabled is false and SQL is not a pure read / #temp batch. */
export const QUERY_WRITE_DISABLED_MESSAGE =
  "Connector is read-only (writeEnabled=false). Only SELECT/WITH queries are allowed, or DDL/DML targeting local #temp tables. Enable Write on the connector to mutate real tables — still subject to policy."

/** Shown on approval / policy surfaces so operators don't confuse layers. */
export const APPROVAL_STILL_CAPPED_BY_CONNECTOR_NOTE =
  "Approval clears governance only. This tool is still capped by the connector Write setting — a read-only connector will block real-table writes after approve."

/** Short conflict headline (env Access, Policy editor, approval modal). */
export const POLICY_ALLOWS_CONNECTOR_FORBIDS_SUMMARY =
  "Policy allows write; connector forbids it."

export function syncTargetConnectorReadOnlyMessage(
  targetName: string,
  connectorId?: string | null,
): string {
  const connector = connectorId?.trim()
    ? ` Linked connector: ${connectorId.trim()}.`
    : ""
  return (
    `Target "${targetName}" connector is read-only (writeEnabled=false).` +
    ` Enable Write on the linked connector before sync execute.${connector}`
  )
}

export function policyConnectorWriteConflictDetail(subject: string): string {
  return (
    `${POLICY_ALLOWS_CONNECTOR_FORBIDS_SUMMARY} Governance allows writes for ${subject}, ` +
    `but the linked connector has Write disabled. Enable Write on the connector — ` +
    `policy alone cannot mutate data.`
  )
}

export function connectorWriteEnabled(config: Record<string, unknown> | null | undefined): boolean {
  return config?.["writeEnabled"] === true
}

/** Env / policy ops that need a write-capable connector to actually succeed. */
export function operationNeedsConnectorWrite(op: string): boolean {
  return op === "dml" || op === "ddl" || op === "sync_execute"
}

export function allowedOpsNeedConnectorWrite(ops: readonly string[]): boolean {
  return ops.some(operationNeedsConnectorWrite)
}

/**
 * True when approving/running this tool may hit the connector write latch
 * (sync execute always; ad-hoc SQL that is not a pure read opener).
 */
export function toolMayHitConnectorWriteLatch(
  toolName: string,
  args?: Record<string, unknown> | null,
): boolean {
  if (toolName === "sync_execute" || toolName.endsWith("_sync_execute")) return true
  if (toolName !== "query_mssql" && !toolName.endsWith("_query_mssql")) return false
  const sql = typeof args?.["query"] === "string" ? args["query"] : typeof args?.["sql"] === "string" ? args["sql"] : ""
  if (!sql.trim()) return true
  return !/^\s*(SELECT|WITH|EXPLAIN|SET\s+SHOWPLAN|SP_HELP|SP_COLUMNS|SP_TABLES)\b/i.test(sql)
}

export function labelValidationCode(code: string | null | undefined): string | null {
  if (!code) return null
  if (code === WRITE_DISABLED_VALIDATION_CODE) return WRITE_DISABLED_LABEL
  return code
}

export interface ConnectorWriteConflict {
  summary: string
  detail: string
  envName?: string
  connectorId?: string
  policyName?: string
  toolName?: string
}

/** Env access allows write ops but the linked MSSQL connector is read-only. */
export function conflictForEnvAccessVsConnector(input: {
  envName: string
  connectorId: string | null | undefined
  allowedOperations: readonly string[]
  connectorWriteEnabled: boolean | null
}): ConnectorWriteConflict | null {
  if (!allowedOpsNeedConnectorWrite(input.allowedOperations)) return null
  if (input.connectorWriteEnabled !== false) return null
  const subject = `environment "${input.envName}"`
  return {
    summary: POLICY_ALLOWS_CONNECTOR_FORBIDS_SUMMARY,
    detail: policyConnectorWriteConflictDetail(subject),
    envName: input.envName,
    connectorId: input.connectorId ?? undefined,
  }
}

/** Policy rule allows / requires approval for write ops against a read-only connector env. */
export function conflictForPolicyRuleVsConnector(input: {
  policyName: string
  effect: string
  dbOperation?: string | null
  dbEnvironment?: string | null
  envName: string
  connectorId: string | null | undefined
  connectorWriteEnabled: boolean | null
}): ConnectorWriteConflict | null {
  if (input.effect !== "allow" && input.effect !== "require_approval") return null
  if (!input.dbOperation || !operationNeedsConnectorWrite(input.dbOperation)) return null
  if (input.connectorWriteEnabled !== false) return null
  if (
    input.dbEnvironment &&
    input.dbEnvironment.toLowerCase() !== input.envName.toLowerCase()
  ) {
    return null
  }
  return {
    summary: POLICY_ALLOWS_CONNECTOR_FORBIDS_SUMMARY,
    detail: policyConnectorWriteConflictDetail(
      `policy "${input.policyName}" (${input.dbOperation} on ${input.envName})`,
    ),
    envName: input.envName,
    connectorId: input.connectorId ?? undefined,
    policyName: input.policyName,
  }
}

/** Approval modal: governance cleared but connector will still refuse writes. */
export function conflictForApprovalVsConnector(input: {
  toolName: string
  args?: Record<string, unknown> | null
  /** Resolved writeEnabled for the connection / sync target; null = unknown. */
  connectorWriteEnabled: boolean | null
  connectorId?: string | null
  envName?: string | null
}): ConnectorWriteConflict | null {
  if (!toolMayHitConnectorWriteLatch(input.toolName, input.args)) return null
  if (input.connectorWriteEnabled !== false) return null
  const subject = input.envName
    ? `tool "${input.toolName}" → ${input.envName}`
    : `tool "${input.toolName}"`
  return {
    summary: POLICY_ALLOWS_CONNECTOR_FORBIDS_SUMMARY,
    detail: `${policyConnectorWriteConflictDetail(subject)} ${APPROVAL_STILL_CAPPED_BY_CONNECTOR_NOTE}`,
    envName: input.envName ?? undefined,
    connectorId: input.connectorId ?? undefined,
    toolName: input.toolName,
  }
}
