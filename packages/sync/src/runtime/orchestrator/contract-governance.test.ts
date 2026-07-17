import type { ConnectionPool } from "mssql"
import { describe, expect, it, vi } from "vitest"

import {
  runContractAuditGateOnSource,
  setContractLockOnSource
} from "./contract-deploy.js"

const trackedExecute = vi.fn()

vi.mock("./db-helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db-helpers.js")>()
  return {
    ...actual,
    trackedExecute: (...args: unknown[]) => trackedExecute(...args),
    trackedQuery: vi.fn(),
  }
})

describe("contract governance on source", () => {
  it("runContractAuditGateOnSource uses source connection", async () => {
    trackedExecute.mockResolvedValueOnce({
      recordsets: [[{ status: "success", message: "ok" }]]
    })
    const pool = { request: () => ({ input: () => ({}) }) } as unknown as ConnectionPool
    await runContractAuditGateOnSource(
      {} as never,
      pool,
      "UAT",
      "audit-check",
      { action: "syncOrNot", objType: "Contract", id: 42 }
    )
    expect(trackedExecute).toHaveBeenCalledWith(
      expect.anything(),
      "UAT",
      "core.uspAuditRunCheck",
      expect.stringContaining("syncOrNot"),
      undefined,
      expect.anything(),
      expect.stringMatching(/^EXEC core\.uspAuditRunCheck /),
    )
  })

  it("setContractLockOnSource uses source connection", async () => {
    trackedExecute.mockResolvedValueOnce({})
    const pool = { request: () => ({ input: () => ({}) }) } as unknown as ConnectionPool
    await setContractLockOnSource({} as never, pool, "UAT", 42, false)
    expect(trackedExecute).toHaveBeenCalledWith(
      expect.anything(),
      "UAT",
      "core.uspSetContractLock",
      expect.stringContaining("setContractLock"),
      undefined,
      expect.anything()
    )
  })
})
