import { describe, expect, it } from "vitest"
import type { Connector, Row } from "@mia/shared-types"
import { createObjectFileAdapter, type FileTransferDriver } from "../../src/adapters/object-file.js"

function connector(kind: "aws" | "azure" | "ftp"): Connector {
  return {
    id: kind,
    kind,
    name: kind,
    displayName: kind,
    config: {},
    enabled: true,
    createdAt: "",
    updatedAt: "",
    updatedBy: null,
  }
}

function mockDriver(readText: (path: string) => Promise<string>): FileTransferDriver & { putCalls: string[] } {
  const d = {
    putCalls: [] as string[],
    async readText(path: string) {
      return readText(path)
    },
    async putText(path: string, _mode: string, body: ReadableStream<Uint8Array>) {
      d.putCalls.push(path)
      const reader = body.getReader()
      while (true) {
        const { done } = await reader.read()
        if (done) break
      }
    },
    async close() {},
  }
  return d
}

describe("object-file adapter", () => {
  it("reads CSV via aws kind", async () => {
    const csv = "id,name\n1,alice\n2,bob"
    const driver = mockDriver(async () => csv)
    const adapter = createObjectFileAdapter("aws", connector("aws"), {
      driverProvider: async () => driver,
      batchSize: 10,
    })
    await adapter.open()
    const out: Row[][] = []
    for await (const b of adapter.read({ kind: "aws", path: "data.csv", format: "csv" })) out.push(b)
    await adapter.close()
    expect(out).toEqual([[{ id: "1", name: "alice" }, { id: "2", name: "bob" }]])
  })

  it("writes via ftp kind", async () => {
    const driver = mockDriver(async () => "")
    const adapter = createObjectFileAdapter("ftp", connector("ftp"), {
      driverProvider: async () => driver,
    })
    await adapter.open()
    async function* rows(): AsyncGenerator<Row[]> {
      yield [{ id: "1" }]
    }
    const summary = await adapter.write(
      { kind: "ftp", path: "/out.csv", format: "json", mode: "replace" },
      rows(),
    )
    await adapter.close()
    expect(summary.status).toBe("completed")
    expect(driver.putCalls).toEqual(["/out.csv"])
  })
})
