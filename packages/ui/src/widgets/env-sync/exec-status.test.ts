import { describe, expect, it } from "vitest"

import { buildExecTableStatus } from "./exec-status"
import type { ExecState } from "./types"

describe("buildExecTableStatus", () => {
  it("marks prior in-txn tables as failed when metadata sync rolls back", () => {
    const exec: ExecState = {
      kind: "done",
      success: false,
      events: [
        { type: "table-started", table: "core.ContractColumn" },
        {
          type: "table-progress",
          table: "core.ContractColumn",
          rowsApplied: 1,
          message: "Applied in transaction (not yet committed)",
        },
        { type: "table-started", table: "core.DatasetMapping" },
        {
          type: "failed",
          step: "metadataSync",
          table: "core.DatasetMapping",
          error: "metadataSync / upsert / core.DatasetMapping failed",
        },
        {
          type: "step",
          step: "metadataSync",
          message: "Metadata sync rolled back — no target metadata changes were committed.",
        },
      ],
    }

    const statuses = buildExecTableStatus(exec)
    expect(statuses.get("core.ContractColumn")).toBe("failed")
    expect(statuses.get("core.DatasetMapping")).toBe("failed")
  })

  it("shows committed tables only after table-done", () => {
    const exec: ExecState = {
      kind: "running",
      startedAt: 0,
      lastEventAt: 0,
      events: [
        { type: "table-started", table: "core.ContractColumn" },
        {
          type: "table-progress",
          table: "core.ContractColumn",
          rowsApplied: 1,
          message: "Applied in transaction (not yet committed)",
        },
      ],
    }

    expect(buildExecTableStatus(exec).get("core.ContractColumn")).toBe("applying")
  })
})
