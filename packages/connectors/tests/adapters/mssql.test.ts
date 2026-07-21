import { describe, expect, it } from "vitest"
import type { Connector, MoveSummary, Row } from "@mia/shared-types"
import {
  createMssqlAdapter,
  type MssqlDriver,
  type MssqlInsertOptions,
  type MssqlTransaction,
} from "../../src/adapters/mssql.js"

function mockConnector(): Connector {
  return {
    id: "src",
    kind: "mssql",
    name: "src",
    displayName: "Source",
    config: {},
    enabled: true,
    createdAt: "",
    updatedAt: "",
    updatedBy: null,
  }
}

interface MockDriver extends MssqlDriver {
  readonly inserted: Row[][]
  truncated: string | null
  committed: boolean
  rolledBack: boolean
  constraintsChecked: boolean[]
  lastInsertOpts: MssqlInsertOptions | undefined
  insertFailAtBatch?: number
}

function mockDriver(streamBatches: Row[][]): MockDriver {
  const driver: MockDriver = {
    inserted: [],
    truncated: null,
    committed: false,
    rolledBack: false,
    constraintsChecked: [],
    lastInsertOpts: undefined,
    async *streamQuery(_sql, batchSize) {
      let buf: Row[] = []
      for (const row of streamBatches.flat()) {
        buf.push(row)
        if (buf.length >= batchSize) {
          yield buf
          buf = []
        }
      }
      if (buf.length > 0) yield buf
    },
    async beginTransaction() {
      return makeTx()
    },
    async insertBatches(table, rows, options) {
      driver.lastInsertOpts = options
      return doInsert(null, table, rows)
    },
    async close() {},
  }
  function makeTx(): MssqlTransaction {
    return {
      async truncate(table) {
        driver.truncated = table
      },
      async setConstraintsChecked(_table, checked) {
        driver.constraintsChecked.push(checked)
      },
      async insertBatches(table, rows, options) {
        driver.lastInsertOpts = options
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
  async function doInsert(
    d: MockDriver | null,
    table: string,
    rows: AsyncGenerator<Row[]>,
  ): Promise<MoveSummary> {
    let written = 0
    let idx = 0
    for await (const batch of rows) {
      if (d && d.insertFailAtBatch !== undefined && idx === d.insertFailAtBatch) {
        return {
          status: "partial",
          rowsRead: written,
          rowsWritten: written,
          errors: [{ row: written, message: "injected" }],
          failedAtRow: written,
        }
      }
      if (d) d.inserted.push(batch)
      else driver.inserted.push(batch)
      void table
      written += batch.length
      idx++
    }
    return { status: "completed", rowsRead: written, rowsWritten: written, errors: [], failedAtRow: null }
  }
  return driver
}

describe("mssql adapter", () => {
  it("streams rows from a SQL read spec", async () => {
    const driver = mockDriver([[{ a: 1 }, { a: 2 }], [{ a: 3 }]])
    const adapter = createMssqlAdapter(mockConnector(), {
      driverProvider: async () => driver,
      batchSize: 2,
    })
    await adapter.open()
    const batches: Row[][] = []
    for await (const b of adapter.read({ kind: "sql", sql: "SELECT a FROM t" })) batches.push(b)
    await adapter.close()
    expect(batches).toEqual([[{ a: 1 }, { a: 2 }], [{ a: 3 }]])
  })

  it("append-writes batches via insertBatches", async () => {
    const driver = mockDriver([])
    const adapter = createMssqlAdapter(mockConnector(), {
      driverProvider: async () => driver,
    })
    await adapter.open()
    const summary = await adapter.write(
      { kind: "sql", table: "t", mode: "append" },
      toAsync([[{ a: 1 }], [{ a: 2 }, { a: 3 }]]),
    )
    await adapter.close()
    expect(summary.status).toBe("completed")
    expect(summary.rowsWritten).toBe(3)
    expect(driver.inserted).toEqual([[{ a: 1 }], [{ a: 2 }, { a: 3 }]])
    expect(driver.truncated).toBeNull()
    expect(driver.lastInsertOpts).toBeUndefined()
  })

  it("replace truncates + inserts in a transaction and commits", async () => {
    const driver = mockDriver([])
    const adapter = createMssqlAdapter(mockConnector(), {
      driverProvider: async () => driver,
    })
    await adapter.open()
    const summary = await adapter.write(
      { kind: "sql", table: "t", mode: "replace" },
      toAsync([[{ a: 1 }], [{ a: 2 }]]),
    )
    await adapter.close()
    expect(summary.status).toBe("completed")
    expect(driver.truncated).toBe("t")
    expect(driver.committed).toBe(true)
    expect(driver.rolledBack).toBe(false)
  })

  it("append with identity passes identityInsert into the insert batch", async () => {
    const driver = mockDriver([])
    const adapter = createMssqlAdapter(mockConnector(), {
      driverProvider: async () => driver,
    })
    await adapter.open()
    const summary = await adapter.write(
      {
        kind: "sql",
        table: "dbo.t",
        mode: "append",
        allowIdentityInsert: true,
        relaxConstraints: true,
      },
      toAsync([[{ id: 1 }]]),
    )
    await adapter.close()
    expect(summary.status).toBe("completed")
    expect(driver.truncated).toBeNull()
    expect(driver.constraintsChecked).toEqual([false, true])
    expect(driver.lastInsertOpts).toEqual({ identityInsert: true })
    expect(driver.committed).toBe(true)
  })

  it("replace rolls back when an insert batch fails", async () => {
    const driver = mockDriver([])
    driver.insertFailAtBatch = 1
    const adapter = createMssqlAdapter(mockConnector(), {
      driverProvider: async () => driver,
    })
    await adapter.open()
    const summary = await adapter.write(
      { kind: "sql", table: "t", mode: "replace" },
      toAsync([[{ a: 1 }], [{ a: 2 }], [{ a: 3 }]]),
    )
    await adapter.close()
    expect(summary.status).toBe("failed")
    expect(driver.rolledBack).toBe(true)
    expect(driver.committed).toBe(false)
  })

})

async function* toAsync(batches: Row[][]): AsyncGenerator<Row[]> {
  for (const b of batches) yield b
}
