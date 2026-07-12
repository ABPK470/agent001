import { describe, expect, it } from "vitest"

import { countMetadataTableProgress } from "./exec-progress"
import { buildExecTableStatus } from "./exec-status"
import type { ExecState } from "./types"

describe("countMetadataTableProgress", () => {
  it("counts applying vs committed separately", () => {
    const exec: ExecState = {
      kind: "running",
      startedAt: 0,
      lastEventAt: 0,
      events: [
        { type: "table-done", table: "core.A" },
        { type: "table-progress", table: "core.B", rowsApplied: 2 },
      ],
    }
    const tables = ["core.A", "core.B", "core.C"]
    const status = buildExecTableStatus(exec)
    const progress = countMetadataTableProgress(exec, tables, status)
    expect(progress.committed).toBe(1)
    expect(progress.applying).toBe(1)
    expect(progress.pending).toBe(1)
  })
})
