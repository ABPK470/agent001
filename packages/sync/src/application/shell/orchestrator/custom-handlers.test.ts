import type { ConnectionPool } from "mssql"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { substituteInputTokens } from "@mia/shared-types"
import { replaceEnvironments, withPermissionDefaults } from "../../../domain/environments.js"
import type { SyncRuntimeHost } from "../../../ports/host.js"
import { trackedQuery } from "./db-helpers.js"
import { runCustomShellFlowStep, runCustomSqlFlowStep } from "./custom-handlers.js"
import { testFlowStepRunContext } from "../../../test-support/value-source-context.js"

vi.mock("./db-helpers.js", () => ({
  trackedExecute: vi.fn(),
  trackedQuery: vi.fn(),
}))

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}))

import { execFile } from "node:child_process"

const trackedQueryMock = vi.mocked(trackedQuery)
const execFileMock = vi.mocked(execFile)

function createHost(): SyncRuntimeHost {
  const host = {
    sync: { environments: { items: new Map() } },
  } as unknown as SyncRuntimeHost
  replaceEnvironments(host, [
    withPermissionDefaults({ name: "UAT" }),
    withPermissionDefaults({ name: "DEV" }),
  ])
  return host
}

function createCtx(host: SyncRuntimeHost) {
  return testFlowStepRunContext({ host })
}

describe("custom-handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    trackedQueryMock.mockResolvedValue({ recordset: [{ sum: 99 }] } as never)
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _opts: object,
        cb: (err: null, stdout: Buffer, stderr: Buffer) => void,
      ) => {
        cb(null, Buffer.from("ok"), Buffer.from(""))
      },
    )
  })

  it("substitutes input tokens from resolved values", () => {
    expect(substituteInputTokens("echo @id @entityId @stepId", { id: 9, entityId: 9, stepId: "s1" })).toBe(
      "echo 9 9 s1",
    )
  })

  it("runs custom SQL with default input slots", async () => {
    const host = createHost()
    const ctx = createCtx(host)
    ctx.plan = { source: "UAT", target: "DEV" } as never
    const result = await runCustomSqlFlowStep(
      ctx,
      { id: "sql-step", kind: "mySql", title: "SQL", description: "" },
      {
        summary: "",
        description: "",
        handler: { type: "custom_sql", connection: "target", sqlBatch: "SELECT 1 WHERE id = @id" },
        stepFields: {},
        failureMode: "fatal",
      },
    )
    expect(trackedQueryMock).toHaveBeenCalledWith(
      host,
      "DEV",
      "SELECT 1 WHERE id = 788",
      "flowStep.mySql(sql-step)",
      undefined,
      expect.anything(),
    )
    expect(result.outputs).toMatchObject({ id: 788, sum: 99 })
  })

  it("rejects custom SQL when env disallows sync_custom_sql", async () => {
    const host = createHost()
    const ctx = createCtx(host)
    await expect(
      runCustomSqlFlowStep(
        ctx,
        { id: "sql-step", kind: "mySql", title: "SQL", description: "" },
        {
          summary: "",
          description: "",
          handler: { type: "custom_sql", connection: "target", sqlBatch: "SELECT 1" },
          stepFields: {},
          failureMode: "fatal",
        },
      ),
    ).rejects.toThrow(/sync_custom_sql/)
    expect(trackedQueryMock).not.toHaveBeenCalled()
  })

  it("runs shell command with resolved inputs", async () => {
    const host = createHost()
    const ctx = createCtx(host)
    ctx.plan = { source: "UAT", target: "DEV" } as never

    await runCustomShellFlowStep(
      ctx,
      { id: "sh-step", kind: "myShell", title: "Shell", description: "" },
      {
        summary: "",
        description: "",
        handler: {
          type: "custom_shell_script",
          connection: "target",
          shellCommand: "echo @id",
          shellPlatform: "any",
        },
        stepFields: {},
        failureMode: "fatal",
      },
    )
    expect(execFileMock).toHaveBeenCalled()
  })

  it("rejects shell when env disallows sync_shell_execute", async () => {
    const host = createHost()
    const ctx = createCtx(host)
    ctx.plan = { source: "UAT", target: "DEV" } as never
    await expect(
      runCustomShellFlowStep(
        ctx,
        { id: "sh-step", kind: "myShell", title: "Shell", description: "" },
        {
          summary: "",
          description: "",
          handler: {
            type: "custom_shell_script",
            connection: "source",
            shellCommand: "echo hi",
            shellPlatform: "any",
          },
          stepFields: {},
          failureMode: "fatal",
        },
      ),
    ).rejects.toThrow(/sync_shell_execute/)
    expect(execFileMock).not.toHaveBeenCalled()
  })
})
