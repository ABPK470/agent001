import { describe, expect, it } from "vitest"

import {
  conflictForPendingApproval,
  conflictForSyncEnvironment,
  conflictsForPolicyRules,
} from "./connector-write-capability"
import type { ConnectorAdmin, SyncEnvironmentAdmin } from "../types"

function connector(id: string, writeEnabled: boolean): ConnectorAdmin {
  return {
    id,
    name: id,
    displayName: id,
    kind: "mssql",
    enabled: true,
    kindEnabled: true,
    createdAt: "",
    updatedAt: "",
    updatedBy: null,
    config: { writeEnabled },
  } as ConnectorAdmin
}

function env(name: string, connectorId: string, ops: SyncEnvironmentAdmin["allowedOperations"]): SyncEnvironmentAdmin {
  return {
    name,
    displayName: name,
    color: "emerald",
    connectorId,
    role: "both",
    ringOrder: 0,
    agentServiceBaseUrl: null,
    etlServiceBaseUrl: null,
    gateServiceBaseUrl: null,
    defaultAccessMode: ops.includes("sync_execute") ? "read_write" : "read_only",
    allowedOperations: ops,
    denyDml: !ops.includes("dml"),
    denyDdl: !ops.includes("ddl"),
    approvalRequiredOperations: [],
    allowedSyncEnvironments: null,
    updatedAt: "",
    updatedBy: null,
  }
}

describe("connector-write-capability UI helpers", () => {
  it("flags sync env when access allows write but connector is read-only", () => {
    const conflict = conflictForSyncEnvironment(
      env("UAT", "uat-db", ["query_read", "sync_execute", "dml"]),
      [connector("uat-db", false)],
    )
    expect(conflict?.summary).toMatch(/Policy allows write/)
  })

  it("flags allow-DML policy against read-only connector env", () => {
    const conflicts = conflictsForPolicyRules({
      rules: [
        {
          name: "allow_uat_dml",
          effect: "allow",
          condition: "selectors",
          parameters: {
            selectors: { dbOperation: "dml", dbEnvironment: "uat" },
          },
        },
      ],
      envs: [env("UAT", "uat-db", ["query_read", "dml"])],
      connectors: [connector("uat-db", false)],
    })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.policyName).toBe("allow_uat_dml")
  })

  it("flags sync_execute approval when target connector is read-only", () => {
    const conflict = conflictForPendingApproval({
      toolName: "sync_execute",
      args: { target: "UAT" },
      envs: [env("UAT", "uat-db", ["sync_execute"])],
      connectors: [connector("uat-db", false)],
    })
    expect(conflict?.toolName).toBe("sync_execute")
  })
})
