import { describe, expect, it } from "vitest"

import {
  APPROVAL_STILL_CAPPED_BY_CONNECTOR_NOTE,
  conflictForApprovalVsConnector,
  conflictForEnvAccessVsConnector,
  conflictForPolicyRuleVsConnector,
  connectorWriteEnabled,
  labelValidationCode,
  QUERY_WRITE_DISABLED_MESSAGE,
  syncTargetConnectorReadOnlyMessage,
  toolMayHitConnectorWriteLatch,
  WRITE_DISABLED_LABEL,
  WRITE_DISABLED_VALIDATION_CODE,
} from "./connector-write-capability.js"

describe("connector-write-capability", () => {
  it("labels write_disabled as connector read-only", () => {
    expect(labelValidationCode(WRITE_DISABLED_VALIDATION_CODE)).toBe(WRITE_DISABLED_LABEL)
    expect(labelValidationCode("invented_column")).toBe("invented_column")
  })

  it("treats sync_execute and non-SELECT SQL as write-latch hits", () => {
    expect(toolMayHitConnectorWriteLatch("sync_execute")).toBe(true)
    expect(toolMayHitConnectorWriteLatch("query_mssql", { query: "SELECT 1" })).toBe(false)
    expect(toolMayHitConnectorWriteLatch("query_mssql", { query: "UPDATE t SET x=1" })).toBe(true)
  })

  it("flags env access vs read-only connector", () => {
    const conflict = conflictForEnvAccessVsConnector({
      envName: "PROD",
      connectorId: "prod-mssql",
      allowedOperations: ["query_read", "sync_execute"],
      connectorWriteEnabled: false,
    })
    expect(conflict?.summary).toMatch(/Policy allows write/)
    expect(conflict?.connectorId).toBe("prod-mssql")
    expect(
      conflictForEnvAccessVsConnector({
        envName: "PROD",
        connectorId: "prod-mssql",
        allowedOperations: ["query_read"],
        connectorWriteEnabled: false,
      }),
    ).toBeNull()
  })

  it("flags allow/require_approval DML against read-only connector", () => {
    expect(
      conflictForPolicyRuleVsConnector({
        policyName: "allow_prod_dml",
        effect: "allow",
        dbOperation: "dml",
        dbEnvironment: "prod",
        envName: "PROD",
        connectorId: "prod-mssql",
        connectorWriteEnabled: false,
      })?.policyName,
    ).toBe("allow_prod_dml")
    expect(
      conflictForPolicyRuleVsConnector({
        policyName: "allow_prod_dml",
        effect: "deny",
        dbOperation: "dml",
        dbEnvironment: "prod",
        envName: "PROD",
        connectorId: "prod-mssql",
        connectorWriteEnabled: false,
      }),
    ).toBeNull()
  })

  it("flags approval when connector is read-only", () => {
    const conflict = conflictForApprovalVsConnector({
      toolName: "sync_execute",
      connectorWriteEnabled: false,
      envName: "UAT",
    })
    expect(conflict?.detail).toContain(APPROVAL_STILL_CAPPED_BY_CONNECTOR_NOTE)
  })

  it("exposes stable operator messages", () => {
    expect(QUERY_WRITE_DISABLED_MESSAGE).toMatch(/Connector is read-only/)
    expect(syncTargetConnectorReadOnlyMessage("PROD", "prod-db")).toMatch(/PROD/)
    expect(connectorWriteEnabled({ writeEnabled: true })).toBe(true)
    expect(connectorWriteEnabled({ writeEnabled: false })).toBe(false)
  })
})
