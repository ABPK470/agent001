/**
 * movement-hdfs.test.ts — e2e through buildConnectorPort with webhdfs adapters
 * (mocked drivers). Verifies the registry wires the webhdfs kind and the
 * streaming engine pipes CSV/JSON files end-to-end.
 */

import { describe, expect, it } from "vitest"
import type { Connector, Row } from "@mia/shared-types"
import { AdapterRegistry, buildConnectorPort } from "../src/registry.js"
import { createWebhdfsAdapter, type WebHdfsDriver } from "../src/adapters/webhdfs.js"

function connector(id: string, kind: Connector["kind"], config: Record<string, unknown>): Connector {
  return {
    id,
    kind,
    name: id,
    displayName: id,
    config: config as Connector["config"],
    enabled: true,
    createdAt: "",
    updatedAt: "",
    updatedBy: null,
  }
}

function mockHdfs(files: Record<string, string>): WebHdfsDriver & { uploads: { path: string; mode: string; text: string }[] } {
  const uploads: { path: string; mode: string; text: string }[] = []
  return {
    uploads,
    async readText(path) {
      return files[path] ?? ""
    },
    async putText(path, mode, body) {
      const reader = body.getReader()
      const chunks: Uint8Array[] = []
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) chunks.push(value)
      }
      uploads.push({ path, mode, text: new TextDecoder().decode(Buffer.concat(chunks)) })
    },
    async close() {},
  }
}

describe("data movement: webhdfs (e2e via port)", () => {
  it("reads a CSV file from HDFS and writes rows to another HDFS path", async () => {
    const hdfs = mockHdfs({ "/in/x.csv": "id,name\n1,alice\n2,bob\n3,carol" })

    const registry = new AdapterRegistry()
    registry.register("webhdfs", (c) => createWebhdfsAdapter(c, { driverProvider: async () => hdfs, batchSize: 2 }))

    const port = buildConnectorPort(registry, [
      connector("hdfs-src", "webhdfs", { host: "nn" }),
      connector("hdfs-tgt", "webhdfs", { host: "nn" }),
    ])

    const summary = await port.moveData(
      { connectorId: "hdfs-src", spec: { kind: "webhdfs", path: "/in/x.csv", format: "csv" } },
      { connectorId: "hdfs-tgt", spec: { kind: "webhdfs", path: "/out/y.csv", format: "csv", mode: "replace" } },
    )

    expect(summary.status).toBe("completed")
    expect(summary.rowsRead).toBe(3)
    expect(summary.rowsWritten).toBe(3)
    expect(hdfs.uploads).toHaveLength(1)
    expect(hdfs.uploads[0]!.path).toBe("/out/y.csv")
    expect(hdfs.uploads[0]!.mode).toBe("replace")
    expect(hdfs.uploads[0]!.text).toBe("id,name\n1,alice\n2,bob\n3,carol\n")
  })

  it("reads JSON from one HDFS path and writes a CSV file to another (replace)", async () => {
    const hdfs = mockHdfs({ "/in/data.json": '[{"a":1,"b":"x"},{"a":2,"b":"y"}]' })

    const registry = new AdapterRegistry()
    registry.register("webhdfs", (c) => createWebhdfsAdapter(c, { driverProvider: async () => hdfs }))

    const port = buildConnectorPort(registry, [
      connector("hdfs-src", "webhdfs", { host: "nn" }),
      connector("hdfs-tgt", "webhdfs", { host: "nn" }),
    ])

    const summary = await port.moveData(
      { connectorId: "hdfs-src", spec: { kind: "webhdfs", path: "/in/data.json", format: "json" } },
      { connectorId: "hdfs-tgt", spec: { kind: "webhdfs", path: "/out/y.csv", format: "csv", mode: "replace" } },
    )

    expect(summary.status).toBe("completed")
    expect(summary.rowsWritten).toBe(2)
    expect(hdfs.uploads).toHaveLength(1)
    expect(hdfs.uploads[0]!.path).toBe("/out/y.csv")
    expect(hdfs.uploads[0]!.text).toBe("a,b\n1,x\n2,y\n")
  })

  it("applies a transform between HDFS CSV read and write", async () => {
    const hdfs = mockHdfs({ "/in/x.csv": "k,v\n1,foo\n2,bar" })
    const registry = new AdapterRegistry()
    registry.register("webhdfs", (c) => createWebhdfsAdapter(c, { driverProvider: async () => hdfs }))
    const port = buildConnectorPort(registry, [
      connector("hdfs-src", "webhdfs", {}),
      connector("hdfs-tgt", "webhdfs", {}),
    ])

    await port.moveData(
      { connectorId: "hdfs-src", spec: { kind: "webhdfs", path: "/in/x.csv", format: "csv" } },
      { connectorId: "hdfs-tgt", spec: { kind: "webhdfs", path: "/out/y.csv", format: "csv", mode: "replace" } },
      { transform: { columns: [{ from: "k", to: "key", cast: "string" }], derive: [{ to: "label", template: "v=${v}" }] } },
    )

    expect(hdfs.uploads[0]!.text).toBe("key,label\n1,v=foo\n2,v=bar\n")
  })

  it("listAdapters reports webhdfs capabilities", async () => {
    const hdfs = mockHdfs({})
    const registry = new AdapterRegistry()
    registry.register("webhdfs", (c) => createWebhdfsAdapter(c, { driverProvider: async () => hdfs }))
    const port = buildConnectorPort(registry, [connector("hdfs", "webhdfs", {})])
    const list = await port.listAdapters()
    expect(list[0]!.capabilities).toEqual({ read: true, write: true, query: false })
  })
})
