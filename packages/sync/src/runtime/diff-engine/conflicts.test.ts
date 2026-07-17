import { beforeEach, describe, expect, it, vi } from "vitest"

const runQueryMock = vi.fn()

vi.mock("./sql-query.js", () => ({
  runQueryWithRetry: (...args: unknown[]) => runQueryMock(...args)
}))

import { detectScopeMisattribution } from "./conflicts.js"

describe("detectScopeMisattribution", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns empty when there are no insert candidates", async () => {
    const conflicts = await detectScopeMisattribution(
      {} as never,
      "UAT",
      { name: "core.Pipeline", scopeColumn: "contractId", predicate: "contractId = {id}" },
      1,
      ["pipelineId"],
      [],
      5
    )
    expect(conflicts).toEqual([])
    expect(runQueryMock).not.toHaveBeenCalled()
  })

  it("skips root tables where scope column equals PK", async () => {
    const conflicts = await detectScopeMisattribution(
      {} as never,
      "UAT",
      { name: "core.Contract", scopeColumn: "contractId", predicate: "contractId = {id}" },
      1,
      ["contractId"],
      [{ pk: "1", rowHash: "a", pkValues: { contractId: 1 } }],
      5
    )
    expect(conflicts).toEqual([])
  })

  it("skips tables without scopeColumn", async () => {
    const conflicts = await detectScopeMisattribution(
      {} as never,
      "UAT",
      { name: "core.Step", scopeColumn: null, predicate: "x" },
      1,
      ["step-id"],
      [{ pk: "1", rowHash: "a", pkValues: { stepId: 1 } }],
      5
    )
    expect(conflicts).toEqual([])
  })

  it("flags rows that exist on target under a different parent scope", async () => {
    runQueryMock.mockResolvedValue({
      recordset: [{ pk: 9, scope: 200 }]
    })
    const conflicts = await detectScopeMisattribution(
      {} as never,
      "UAT",
      { name: "core.Pipeline", scopeColumn: "contractId", predicate: "contractId = {id}" },
      100,
      ["pipelineId"],
      [{ pk: "9", rowHash: "a", pkValues: { pipelineId: 9 } }],
      5
    )
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.pk).toBe("9")
    expect(conflicts[0]?.actualScope.contractId).toBe(200)
    expect(conflicts[0]?.summary).toContain("pipelineId=9")
    expect(runQueryMock.mock.calls[0]?.[2]).toContain("[core].[Pipeline]")
    expect(runQueryMock.mock.calls[0]?.[3]).toContain("detectScopeMisattribution")
  })

  it("returns empty when probe query fails", async () => {
    runQueryMock.mockRejectedValue(new Error("permission denied"))
    const conflicts = await detectScopeMisattribution(
      {} as never,
      "UAT",
      { name: "core.Activity", scopeColumn: "pipelineId", predicate: "pipelineId IN (...)" },
      1,
      ["activityId"],
      [{ pk: "1", rowHash: "a", pkValues: { activityId: 1 } }],
      5
    )
    expect(conflicts).toEqual([])
  })
})
