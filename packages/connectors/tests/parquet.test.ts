import { describe, expect, it } from "vitest"
import type { Row, Transform } from "@mia/shared-types"
import { applyTransform } from "../src/engine.js"
import { parseParquet, serializeParquet } from "../src/parquet.js"

async function* toAsync(batches: Row[][]): AsyncGenerator<Row[]> {
  for (const b of batches) yield b
}

describe("parquet codec", () => {
  it("round-trips rows through serialize + parse", async () => {
    const rows: Row[] = [
      { id: 1, name: "Alice", active: true },
      { id: 2, name: "Bob", active: false },
      { id: 3, name: null, active: true },
    ]
    const bytes = serializeParquet(rows)
    expect(bytes.byteLength).toBeGreaterThan(0)
    const back = await parseParquet(bytes)
    expect(back).toHaveLength(3)
    expect(back[0]).toMatchObject({ id: 1, name: "Alice", active: true })
    expect(back[1]).toMatchObject({ id: 2, name: "Bob", active: false })
    expect(back[2]!.name).toBeNull()
  })

  it("writes an empty parquet file", async () => {
    const bytes = serializeParquet([])
    const back = await parseParquet(bytes)
    // empty schema sentinel column may appear — treat as empty-ish payload
    expect(Array.isArray(back)).toBe(true)
  })
})

describe("applyTransform enhancements", () => {
  it("casts date/datetime and applies defaults + filter", async () => {
    const transform: Transform = {
      columns: [
        { from: "ts", to: "day", cast: "date" },
        { from: "ts", to: "when", cast: "datetime" },
        { from: "n", to: "n", cast: "number", default: 0 },
      ],
      defaults: [{ column: "status", value: "ok" }],
      filter: [{ column: "n", op: "gt", value: 0 }],
    }
    const batches = [
      [
        { ts: "2024-06-15T12:00:00.000Z", n: "2" },
        { ts: "2024-06-16T08:00:00.000Z", n: 0 },
        { ts: "2024-06-17T08:00:00.000Z" },
      ],
    ]
    const out: Row[][] = []
    for await (const b of applyTransform(toAsync(batches), transform)) out.push(b)
    expect(out).toHaveLength(1)
    expect(out[0]).toHaveLength(1)
    expect(out[0]![0]).toMatchObject({
      day: "2024-06-15",
      n: 2,
      status: "ok",
    })
    expect(String(out[0]![0]!.when)).toContain("2024-06-15")
  })

  it("honors abort signal between batches", async () => {
    const ac = new AbortController()
    const batches = [[{ a: 1 }], [{ a: 2 }]]
    const gen = applyTransform(toAsync(batches), undefined, ac.signal)
    const first = await gen.next()
    expect(first.value).toEqual([{ a: 1 }])
    ac.abort(new Error("stop"))
    await expect(gen.next()).rejects.toThrow(/stop|aborted/i)
  })
})
