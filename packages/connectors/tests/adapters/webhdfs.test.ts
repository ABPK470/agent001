import { describe, expect, it } from "vitest"
import type { Connector, Row } from "@mia/shared-types"
import { createWebhdfsAdapter, type WebHdfsDriver } from "../../src/adapters/webhdfs.js"
import { parseCsv, serializeRows } from "../../src/adapters/webhdfs.js"

function connector(writeEnabled = true): Connector {
  return {
    id: "hdfs",
    kind: "webhdfs",
    name: "hdfs",
    displayName: "HDFS",
    config: { host: "nn", port: 50070, writeEnabled },
    enabled: true,
    createdAt: "",
    updatedAt: "",
    updatedBy: null,
  }
}

interface MockWebHdfsDriver extends WebHdfsDriver {
  putCalls: { path: string; mode: string; bytes: Uint8Array }[]
  putError?: Error
  readTextImpl: (path: string) => Promise<string>
}

function mockDriver(readText: (path: string) => Promise<string>): MockWebHdfsDriver {
  const d: MockWebHdfsDriver = {
    putCalls: [],
    readTextImpl: readText,
    async readText(path) {
      return d.readTextImpl(path)
    },
    async putText(path, mode, body) {
      if (d.putError) throw d.putError
      const reader = body.getReader()
      const chunks: Uint8Array[] = []
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) chunks.push(value)
      }
      const merged = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
      let off = 0
      for (const c of chunks) {
        merged.set(c, off)
        off += c.length
      }
      d.putCalls.push({ path, mode, bytes: merged })
    },
    async close() {},
  }
  return d
}

async function* toAsync(batches: Row[][]): AsyncGenerator<Row[]> {
  for (const b of batches) yield b
}

describe("webhdfs adapter — read", () => {
  it("parses a CSV file (header row) into rows and re-batches", async () => {
    const csv = "id,name\n1,alice\n2,bob\n3,carol\n4,dave"
    const driver = mockDriver(async () => csv)
    const adapter = createWebhdfsAdapter(connector(), { driverProvider: async () => driver, batchSize: 2 })
    await adapter.open()
    const out: Row[][] = []
    for await (const b of adapter.read({ kind: "webhdfs", path: "/data/x.csv", format: "csv" })) out.push(b)
    await adapter.close()
    expect(out).toEqual([
      [{ id: "1", name: "alice" }, { id: "2", name: "bob" }],
      [{ id: "3", name: "carol" }, { id: "4", name: "dave" }],
    ])
  })

  it("parses a JSON array file into rows", async () => {
    const json = JSON.stringify([{ a: 1 }, { a: 2 }, { a: 3 }])
    const driver = mockDriver(async () => json)
    const adapter = createWebhdfsAdapter(connector(), { driverProvider: async () => driver, batchSize: 10 })
    await adapter.open()
    const out: Row[][] = []
    for await (const b of adapter.read({ kind: "webhdfs", path: "/data/x.json", format: "json" })) out.push(b)
    await adapter.close()
    expect(out).toEqual([[{ a: 1 }, { a: 2 }, { a: 3 }]])
  })

  it("throws on a non-array JSON payload", async () => {
    const driver = mockDriver(async () => JSON.stringify({ not: "an array" }))
    const adapter = createWebhdfsAdapter(connector(), { driverProvider: async () => driver })
    await adapter.open()
    await expect(async () => {
      for await (const _ of adapter.read({ kind: "webhdfs", path: "/x.json", format: "json" })) {
        /* drain */
      }
    }).rejects.toThrow(/expected a JSON array/)
    await adapter.close()
  })
})

describe("webhdfs adapter — write", () => {
  it("serializes rows to CSV and uploads a single byte stream (replace)", async () => {
    const driver = mockDriver(async () => "")
    const adapter = createWebhdfsAdapter(connector(), { driverProvider: async () => driver, writeEnabled: true })
    await adapter.open()
    const summary = await adapter.write(
      { kind: "webhdfs", path: "/out/x.csv", format: "csv", mode: "replace" },
      toAsync([[{ id: 1, name: "alice" }, { id: 2, name: "bob" }], [{ id: 3, name: "carol" }]]),
    )
    await adapter.close()
    expect(summary.status).toBe("completed")
    expect(summary.rowsWritten).toBe(3)
    expect(driver.putCalls).toHaveLength(1)
    expect(driver.putCalls[0]!.path).toBe("/out/x.csv")
    expect(driver.putCalls[0]!.mode).toBe("replace")
    const text = new TextDecoder().decode(driver.putCalls[0]!.bytes)
    expect(text).toBe("id,name\n1,alice\n2,bob\n3,carol\n")
  })

  it("serializes rows to a JSON array (append)", async () => {
    const driver = mockDriver(async () => "")
    const adapter = createWebhdfsAdapter(connector(), { driverProvider: async () => driver, writeEnabled: true })
    await adapter.open()
    const summary = await adapter.write(
      { kind: "webhdfs", path: "/out/x.json", format: "json", mode: "append" },
      toAsync([[{ a: 1 }, { a: 2 }], [{ a: 3 }]]),
    )
    await adapter.close()
    expect(summary.status).toBe("completed")
    expect(summary.rowsWritten).toBe(3)
    const text = new TextDecoder().decode(driver.putCalls[0]!.bytes)
    expect(text).toBe(`[${JSON.stringify({ a: 1 })},${JSON.stringify({ a: 2 })},${JSON.stringify({ a: 3 })}]`)
  })

  it("quotes CSV fields containing commas / quotes / newlines", async () => {
    const driver = mockDriver(async () => "")
    const adapter = createWebhdfsAdapter(connector(), { driverProvider: async () => driver, writeEnabled: true })
    await adapter.open()
    await adapter.write(
      { kind: "webhdfs", path: "/out/x.csv", format: "csv", mode: "replace" },
      toAsync([[{ v: 'a,b', w: 'he said "hi"\nbye' }]]),
    )
    await adapter.close()
    const text = new TextDecoder().decode(driver.putCalls[0]!.bytes)
    expect(text).toBe('v,w\n"a,b","he said ""hi""\nbye"\n')
  })

  it("reports failed when the upload errors", async () => {
    const driver = mockDriver(async () => "")
    driver.putError = new Error("namenode unavailable")
    const adapter = createWebhdfsAdapter(connector(), { driverProvider: async () => driver, writeEnabled: true })
    await adapter.open()
    const summary = await adapter.write(
      { kind: "webhdfs", path: "/out/x.csv", format: "csv", mode: "replace" },
      toAsync([[{ a: 1 }, { a: 2 }]]),
    )
    await adapter.close()
    expect(summary.status).toBe("failed")
    expect(summary.errors[0]!.message).toContain("namenode unavailable")
  })

  it("refuses to write when writeEnabled is false", async () => {
    const driver = mockDriver(async () => "")
    const adapter = createWebhdfsAdapter(connector(false), { driverProvider: async () => driver, writeEnabled: false })
    await adapter.open()
    const summary = await adapter.write(
      { kind: "webhdfs", path: "/out/x.csv", format: "csv", mode: "replace" },
      toAsync([[{ a: 1 }]]),
    )
    await adapter.close()
    expect(summary.status).toBe("failed")
    expect(summary.errors[0]!.message).toContain("read-only")
    expect(driver.putCalls).toHaveLength(0)
  })

  it("rejects a non-webhdfs spec", async () => {
    const driver = mockDriver(async () => "")
    const adapter = createWebhdfsAdapter(connector(), { driverProvider: async () => driver })
    await adapter.open()
    await expect(async () => {
      for await (const _ of adapter.read({ kind: "sql", sql: "SELECT 1" })) {
        /* drain */
      }
    }).rejects.toThrow(/cannot read spec kind 'sql'/)
    await expect(
      adapter.write({ kind: "sql", table: "t", mode: "append" } as never, toAsync([[{ a: 1 }]])),
    ).rejects.toThrow(/cannot write spec kind 'sql'/)
    await adapter.close()
  })
})

describe("webhdfs csv helpers", () => {
  it("parseCsv round-trips through serializeRows (CSV is type-less: numbers come back as strings)", async () => {
    const rows: Row[] = [{ a: 1, b: "x" }, { a: 2, b: "y" }]
    const enc = new TextEncoder()
    let text = ""
    for await (const chunk of serializeRows(toAsync([rows]), "csv")) {
      text += new TextDecoder().decode(chunk)
    }
    expect(parseCsv(text)).toEqual([{ a: "1", b: "x" }, { a: "2", b: "y" }])
  })

  it("parseCsv handles quoted commas, quotes, and embedded newlines", () => {
    const csv = 'k,v\n1,"a,b"\n2,"line1\nline2"\n3,"quote ""inside"""\n'
    expect(parseCsv(csv)).toEqual([
      { k: "1", v: "a,b" },
      { k: "2", v: "line1\nline2" },
      { k: "3", v: 'quote "inside"' },
    ])
  })
})
