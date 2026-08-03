import { describe, expect, it } from "vitest"
import {
  AUDIT_DETAIL_MAX_BYTES,
  auditSnapshot,
  withBeforeAfter,
  withCatalogVersionRef,
  withEntityVersionRef,
} from "../src/api/admin/audit-detail.js"

describe("audit-detail envelope", () => {
  it("auditSnapshot clones plain objects", () => {
    const snap = auditSnapshot({ name: "x", n: 1 })
    expect(snap).toEqual({ name: "x", n: 1 })
  })

  it("withBeforeAfter embeds create/update/delete sides", () => {
    expect(withBeforeAfter({ name: "p" }, null, { name: "p", effect: "allow" })).toMatchObject({
      name: "p",
      before: null,
      after: { name: "p", effect: "allow" },
    })
    expect(
      withBeforeAfter({ name: "p" }, { effect: "allow" }, { effect: "deny" }),
    ).toMatchObject({
      before: { effect: "allow" },
      after: { effect: "deny" },
    })
    expect(withBeforeAfter({ name: "p" }, { effect: "deny" }, null)).toMatchObject({
      before: { effect: "deny" },
      after: null,
    })
  })

  it("falls back when payload exceeds 50KB (no invalid truncate)", () => {
    const huge = { blob: "x".repeat(AUDIT_DETAIL_MAX_BYTES) }
    const detail = withBeforeAfter({ name: "big" }, huge, { ...huge, flag: true })
    expect(detail.truncated).toBe(true)
    expect(detail.before).toBeUndefined()
    expect(detail.after).toBeUndefined()
    expect(detail.name).toBe("big")
    expect(Array.isArray(detail.fields) || detail.truncated === true).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(detail), "utf8")).toBeLessThanOrEqual(
      AUDIT_DETAIL_MAX_BYTES,
    )
  })

  it("version refs omit bodies", () => {
    expect(
      withEntityVersionRef(
        { tenantId: "t", id: "e1", version: 3, reason: "edit" },
        { tenantId: "t", id: "e1", version: 3, prevVersion: 2 },
      ),
    ).toEqual({
      tenantId: "t",
      id: "e1",
      version: 3,
      reason: "edit",
      ref: { kind: "entity_version", tenantId: "t", id: "e1", version: 3, prevVersion: 2 },
    })
    expect(
      withCatalogVersionRef(
        { publishedVersion: 4 },
        { catalogVersion: 4, againstCatalogVersion: 3 },
      ).ref,
    ).toEqual({ kind: "catalog_version", catalogVersion: 4, againstCatalogVersion: 3 })
  })
})
