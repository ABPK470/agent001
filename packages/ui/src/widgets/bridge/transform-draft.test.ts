import { describe, expect, it } from "vitest"
import type { Transform } from "@mia/shared-types"
import {
  columnNamesFromRows,
  compileTransform,
  draftFromTransform,
  emptyTransformDraft,
  formatTransformJson,
  isPassThrough,
  newColumnDraft,
  newDeriveDraft,
  newFilterDraft,
  parseTransformJson,
  parseValueText,
  seedIdentityColumns,
} from "./transform-draft"

describe("transform-draft", () => {
  it("empty draft is pass-through and compiles to undefined", () => {
    const draft = emptyTransformDraft()
    expect(isPassThrough(draft)).toBe(true)
    expect(compileTransform(draft)).toEqual({ ok: true, transform: undefined })
  })

  it("compiles columns, derive, defaults, and filters without ambiguity", () => {
    const draft = emptyTransformDraft()
    draft.columns = [
      newColumnDraft({ from: "id", to: "key", cast: "string", defaultText: "0" }),
      newColumnDraft({ from: "  ", to: "  " }),
    ]
    draft.derive = [newDeriveDraft({ to: "label", template: "row-${id}" })]
    draft.filters = [
      newFilterDraft({ column: "key", op: "exists" }),
      newFilterDraft({ column: "n", op: "gt", valueText: "1" }),
    ]

    const compiled = compileTransform(draft)
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(compiled.transform).toEqual({
      columns: [{ from: "id", to: "key", cast: "string", default: 0 }],
      derive: [{ to: "label", template: "row-${id}" }],
      filter: [
        { column: "key", op: "exists" },
        { column: "n", op: "gt", value: 1 },
      ],
    })
  })

  it("compiles constant target columns (empty From + Default)", () => {
    const draft = emptyTransformDraft()
    draft.columns = [
      newColumnDraft({ from: "id", to: "id" }),
      newColumnDraft({ from: "", to: "Status", defaultText: "imported" }),
    ]
    expect(isPassThrough(draft)).toBe(false)
    const compiled = compileTransform(draft)
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(compiled.transform).toEqual({
      columns: [
        { from: "id", to: "id" },
        { from: "", to: "Status", default: "imported" },
      ],
    })
  })

  it("rejects target-only column without Default", () => {
    const draft = emptyTransformDraft()
    draft.columns = [newColumnDraft({ from: "", to: "Status" })]
    expect(compileTransform(draft).ok).toBe(false)
  })

  it("rejects incomplete derive / filter values", () => {
    const badDerive = emptyTransformDraft()
    badDerive.derive = [newDeriveDraft({ to: "x", template: "  " })]
    expect(compileTransform(badDerive).ok).toBe(false)

    const badFilter = emptyTransformDraft()
    badFilter.filters = [newFilterDraft({ column: "a", op: "eq", valueText: "" })]
    expect(compileTransform(badFilter).ok).toBe(false)
  })

  it("round-trips Transform ↔ draft ↔ JSON", () => {
    const wire: Transform = {
      columns: [{ from: "a", to: "b", cast: "number" }],
      defaults: [{ column: "status", value: "new" }],
      filter: [{ column: "b", op: "in", value: [1, 2] }],
    }
    const draft = draftFromTransform(wire)
    const compiled = compileTransform(draft)
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(compiled.transform).toEqual(wire)

    const json = formatTransformJson(draft)
    const parsed = parseTransformJson(json)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(compileTransform(parsed.draft)).toEqual(compiled)
  })

  it("seeds identity columns only when map is empty", () => {
    const empty = emptyTransformDraft()
    const seeded = seedIdentityColumns(empty, ["id", "name"])
    expect(seeded.columns.map((c) => c.from)).toEqual(["id", "name"])
    expect(seeded.columns.map((c) => c.to)).toEqual(["id", "name"])

    const again = seedIdentityColumns(seeded, ["other"])
    expect(again.columns.map((c) => c.from)).toEqual(["id", "name"])
  })

  it("parses value text as JSON when possible, else string", () => {
    expect(parseValueText("true")).toBe(true)
    expect(parseValueText("12")).toBe(12)
    expect(parseValueText("hello")).toBe("hello")
    expect(parseValueText('"hello"')).toBe("hello")
  })

  it("collects column names from sample rows in first-seen order", () => {
    expect(columnNamesFromRows([{ b: 1, a: 2 }, { a: 3, c: 4 }])).toEqual(["b", "a", "c"])
  })
})
