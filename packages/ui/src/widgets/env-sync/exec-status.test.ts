import { describe, expect, it } from "vitest"

import { buildExecTableStatus } from "./exec-status"
import type { ExecState } from "./types"

describe("buildExecTableStatus", () => {
  it("marks prior table-done rows as failed when metadata sync rolls back", () => {
    const exec: ExecState = {
      kind: "done",
      success: false,
      startedAt: 0,
      lastEventAt: 0,
      events: [
        { type: "table-started", table: "core.ContractColumn" },
        { type: "table-done", table: "core.ContractColumn", rowsApplied: 1 },
        { type: "table-started", table: "core.DatasetMapping" },
        {
          type: "failed",
          step: "metadataSync",
          table: "core.DatasetMapping",
          error: "metadataSync / upsert / core.DatasetMapping failed",
        },
      ],
    }

    const statuses = buildExecTableStatus(exec)
    expect(statuses.get("core.ContractColumn")).toBe("failed")
    expect(statuses.get("core.DatasetMapping")).toBe("failed")
  })
})
