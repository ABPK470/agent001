import { describe, expect, it } from "vitest"
import type { Connector, MoveSummary, Row } from "@mia/shared-types"
import { createHiveAdapter, defaultHiveDriver, type HiveClient, type HiveDriver, type HiveTransaction } from "../../src/adapters/hive.js"

function connector(): Connector {
  return {
    id: "hv",
    kind: "hive",
    name: "hv",
    displayName: "Hive",
    config: { host: "h" },
    enabled: true,
    createdAt: "",
    updatedAt: "",
    updatedBy: null,
  }
}

interface MockHiveDriver extends HiveDriver {
  readonly inserted: Row[][]
  truncated: string | null
  committed: boolean
  rolledBack: boolean
  insertFailAtBatch?: number
}

function mockDriver(streamRows: Row[]): MockHiveDriver {
  const driver: MockHiveDriver = {
    inserted: [],
    truncated: null,
    committed: false,
    rolledBack: false,
    async* streamQuery(_sql, batchSize) {
      for (let i = 0; i < streamRows.length; i += batchSize) {
        yield streamRows.slice(i, i + batchSize)
      }
    },
    async beginTransaction() {
      return makeTx()
    },
    async insertBatches(table, rows) {
      return doInsert(null, table, rows)
    },
    async close() {},
  }
  function makeTx(): HiveTransaction {
    return {
      async truncate(table) {
        driver.truncated = table
      },
      async insertBatches(table, rows) {
        return doInsert(driver, table, rows)
      },
      async commit() {
        driver.committed = true
      },
      async rollback() {
        driver.rolledBack = true
      },
    }
  }
  async function doInsert(d: MockHiveDriver | null, _table: string, rows: AsyncGenerator<Row[]>): Promise<MoveSummary> {
    let written = 0
    let idx = 0
    for await (const batch of rows) {
      if (d && d.insertFailAtBatch !== undefined && idx === d.insertFailAtBatch) {
        return { status: "partial", rowsRead: written, rowsWritten: written, errors: [{ row: written, message: "injected" }], failedAtRow: written }
      }
      ;(d ?? driver).inserted.push(batch)
      written += batch.length
      idx++
    }
    return { status: "completed", rowsRead: written, rowsWritten: written, errors: [], failedAtRow: null }
  }
  return driver
}

async function* toAsync(batches: Row[][]): AsyncGenerator<Row[]> {
  for (const b of batches) yield b
}

describe("hive adapter", () => {
  it("streams rows from a SQL read spec", async () => {
    const driver = mockDriver([{ a: 1 }, { a: 2 }, { a: 3 }])
    const adapter = createHiveAdapter(connector(), { driverProvider: async () => driver, batchSize: 2 })
    await adapter.open()
    const out: Row[][] = []
    for await (const b of adapter.read({ kind: "sql", sql: "SELECT a FROM t" })) out.push(b)
    await adapter.close()
    expect(out).toEqual([[{ a: 1 }, { a: 2 }], [{ a: 3 }]])
  })

  it("append-writes via insertBatches", async () => {
    const driver = mockDriver([])
    const adapter = createHiveAdapter(connector(), { driverProvider: async () => driver })
    await adapter.open()
    const summary = await adapter.write({ kind: "sql", table: "t", mode: "append" }, toAsync([[{ a: 1 }], [{ a: 2 }, { a: 3 }]]))
    await adapter.close()
    expect(summary.status).toBe("completed")
    expect(summary.rowsWritten).toBe(3)
    expect(driver.inserted).toEqual([[{ a: 1 }], [{ a: 2 }, { a: 3 }]])
    expect(driver.truncated).toBeNull()
  })

  it("replace truncates + inserts in a transaction and commits", async () => {
    const driver = mockDriver([])
    const adapter = createHiveAdapter(connector(), { driverProvider: async () => driver })
    await adapter.open()
    await adapter.write({ kind: "sql", table: "t", mode: "replace" }, toAsync([[{ a: 1 }], [{ a: 2 }]]))
    await adapter.close()
    expect(driver.truncated).toBe("t")
    expect(driver.committed).toBe(true)
    expect(driver.rolledBack).toBe(false)
  })

  it("replace rolls back when an insert batch fails", async () => {
    const driver = mockDriver([])
    driver.insertFailAtBatch = 1
    const adapter = createHiveAdapter(connector(), { driverProvider: async () => driver })
    await adapter.open()
    const summary = await adapter.write({ kind: "sql", table: "t", mode: "replace" }, toAsync([[{ a: 1 }], [{ a: 2 }], [{ a: 3 }]]))
    await adapter.close()
    expect(summary.status).toBe("failed")
    expect(driver.rolledBack).toBe(true)
    expect(driver.committed).toBe(false)
  })

})

describe("defaultHiveDriver (wraps a HiveClient)", () => {
  it("paginates query results until exhausted", async () => {
    let buf: Row[] = [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }, { a: 5 }]
    const client: HiveClient = {
      async query(_sql, maxRows) {
        return buf.splice(0, maxRows)
      },
      async execute() {},
      async close() {},
    }
    const driver = defaultHiveDriver(client)
    const out: Row[][] = []
    for await (const b of driver.streamQuery("SELECT a FROM t", 2)) out.push(b)
    expect(out).toEqual([[{ a: 1 }, { a: 2 }], [{ a: 3 }, { a: 4 }], [{ a: 5 }]])
  })

  it("runs replace inside START TRANSACTION / COMMIT and rolls back on error", async () => {
    const executed: string[] = []
    const client: HiveClient = {
      async query() {
        return []
      },
      async execute(sql) {
        executed.push(sql)
        if (sql.startsWith("INSERT") && executed.filter((s) => s.startsWith("INSERT")).length === 2) {
          throw new Error("hive insert failed")
        }
      },
      async close() {},
    }
    const driver = defaultHiveDriver(client)
    const tx = await driver.beginTransaction()
    await tx.truncate("t")
    await expect(
      tx.insertBatches("t", toAsync([[{ a: 1 }], [{ a: 2 }], [{ a: 3 }]])),
    ).rejects.toThrow("hive insert failed")
    await tx.rollback()
    expect(executed).toContain("START TRANSACTION")
    expect(executed).toContain("TRUNCATE TABLE `t`")
    expect(executed).toContain("ROLLBACK")
  })
})
