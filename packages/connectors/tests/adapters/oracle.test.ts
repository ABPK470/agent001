import { describe, expect, it } from "vitest"
import type { Connector, MoveSummary, Row } from "@mia/shared-types"
import {
  createOracleAdapter,
  type OracleDriver,
  type OracleInsertOptions,
  type OracleTransaction,
} from "../../src/adapters/oracle.js"

function mockConnector(): Connector {
  return {
    id: "ora",
    kind: "oracle",
    name: "ora",
    displayName: "Oracle",
    config: { writeEnabled: true },
    enabled: true,
    createdAt: "",
    updatedAt: "",
    updatedBy: null,
  }
}

interface MockDriver extends OracleDriver {
  readonly inserted: Row[][]
  truncated: string | null
  committed: boolean
  rolledBack: boolean
  constraintsChecked: boolean[]
  lastInsertOpts: OracleInsertOptions | undefined
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
  function makeTx(): OracleTransaction {
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

describe("oracle adapter", () => {
  it("streams rows from a SQL read spec", async () => {
    const driver = mockDriver([[{ A: 1 }, { A: 2 }], [{ A: 3 }]])
    const adapter = createOracleAdapter(mockConnector(), {
      driverProvider: async () => driver,
      writeEnabled: true,
      batchSize: 2,
    })
    await adapter.open()
    const batches: Row[][] = []
    for await (const b of adapter.read({ kind: "sql", sql: "SELECT a FROM t" })) batches.push(b)
    await adapter.close()
    expect(batches).toEqual([[{ A: 1 }, { A: 2 }], [{ A: 3 }]])
  })

  it("append-writes batches via insertBatches", async () => {
    const driver = mockDriver([])
    const adapter = createOracleAdapter(mockConnector(), {
      driverProvider: async () => driver,
      writeEnabled: true,
    })
    await adapter.open()
    const summary = await adapter.write(
      { kind: "sql", table: "HR.T", mode: "append" },
      toAsync([[{ A: 1 }], [{ A: 2 }]]),
    )
    await adapter.close()
    expect(summary.status).toBe("completed")
    expect(summary.rowsWritten).toBe(2)
    expect(driver.truncated).toBeNull()
    expect(driver.lastInsertOpts).toBeUndefined()
  })

  it("passes OVERRIDING when allowIdentityInsert is set", async () => {
    const driver = mockDriver([])
    const adapter = createOracleAdapter(mockConnector(), {
      driverProvider: async () => driver,
      writeEnabled: true,
    })
    await adapter.open()
    await adapter.write(
      { kind: "sql", table: "HR.T", mode: "append", allowIdentityInsert: true },
      toAsync([[{ ID: 1 }]]),
    )
    await adapter.close()
    expect(driver.lastInsertOpts).toEqual({ overridingSystemValue: true })
  })

  it("replace + relaxConstraints disables then restores before commit", async () => {
    const driver = mockDriver([])
    const adapter = createOracleAdapter(mockConnector(), {
      driverProvider: async () => driver,
      writeEnabled: true,
    })
    await adapter.open()
    const summary = await adapter.write(
      {
        kind: "sql",
        table: "HR.T",
        mode: "replace",
        relaxConstraints: true,
      },
      toAsync([[{ A: 1 }]]),
    )
    await adapter.close()
    expect(summary.status).toBe("completed")
    expect(driver.truncated).toBe("HR.T")
    expect(driver.constraintsChecked).toEqual([false, true])
    expect(driver.committed).toBe(true)
  })

  it("refuses to write when writeEnabled is false", async () => {
    const driver = mockDriver([])
    const adapter = createOracleAdapter(mockConnector(), {
      driverProvider: async () => driver,
      writeEnabled: false,
    })
    await adapter.open()
    const summary = await adapter.write(
      { kind: "sql", table: "T", mode: "append" },
      toAsync([[{ A: 1 }]]),
    )
    await adapter.close()
    expect(summary.status).toBe("failed")
    expect(summary.errors[0]!.message).toContain("read-only")
  })
})

async function* toAsync(batches: Row[][]): AsyncGenerator<Row[]> {
  for (const b of batches) yield b
}
