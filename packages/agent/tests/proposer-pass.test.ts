/**
 * F1.1 — `runProposerPass` deterministic behaviour.
 *
 * Covers:
 *  - drift dominates row-level scan
 *  - per-entity cap respected
 *  - maxFindings hard cap
 *  - probe failures increment `errors` without breaking the pass
 *  - identical inputs produce identical fingerprints
 *  - `entityIds` whitelist filter
 */

import {
  ProposalKind,
  runProposerPass,
  type CatalogDriftProbe,
  type DivergentEntityRow,
  type EntityDescriptor,
  type EnvPair,
  type ProposerPassDeps
} from "@mia/sync"
import { describe, expect, it } from "vitest"

function ent(id: string, defVersion = 1): EntityDescriptor {
  return { id, label: `Entity ${id}`, defVersion }
}

function row(id: string, opts: Partial<DivergentEntityRow> = {}): DivergentEntityRow {
  return {
    entityId: id,
    entityLabel: `Row ${id}`,
    counts: { insert: 0, update: 1, delete: 0, unchanged: 0, unknown: 0 },
    perTable: [],
    newOnTarget: false,
    ...opts
  }
}

const envPair: EnvPair = { source: "uat", target: "prod" }
const NOW = "2025-01-15T12:00:00.000Z"

function buildDeps(over: Partial<ProposerPassDeps> = {}): ProposerPassDeps {
  return {
    listEntities: async () => [],
    probeCatalogDrift: async () => ({ issues: [] }),
    scanDivergentRows: async () => [],
    now: () => NOW,
    ...over
  }
}

describe("runProposerPass", () => {
  it("emits exactly one Drift finding when catalog drift is present (skips rows)", async () => {
    let scanned = 0
    const deps = buildDeps({
      listEntities: async () => [ent("contract")],
      probeCatalogDrift: async () => ({ issues: ["missing column foo"] }) satisfies CatalogDriftProbe,
      scanDivergentRows: async () => {
        scanned++
        return []
      }
    })
    const r = await runProposerPass(envPair, {}, deps)
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]!.kind).toBe(ProposalKind.Drift)
    expect(r.findings[0]!.entityId).toBe("*")
    expect(scanned).toBe(0)
  })

  it("respects perEntityCap", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`r${i}`))
    const deps = buildDeps({
      listEntities: async () => [ent("contract")],
      scanDivergentRows: async () => rows
    })
    const r = await runProposerPass(envPair, { perEntityCap: 4 }, deps)
    expect(r.findings).toHaveLength(4)
  })

  it("respects maxFindings", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => row(`r${i}`))
    const deps = buildDeps({
      listEntities: async () => [ent("a"), ent("b")],
      scanDivergentRows: async () => rows
    })
    const r = await runProposerPass(envPair, { perEntityCap: 100, maxFindings: 7 }, deps)
    expect(r.findings).toHaveLength(7)
  })

  it("increments errors but keeps going on probe failure", async () => {
    const deps = buildDeps({
      listEntities: async () => [ent("a"), ent("b")],
      probeCatalogDrift: async (_p, e) => {
        if (e.id === "a") throw new Error("boom")
        return { issues: [] }
      },
      scanDivergentRows: async () => [row("r1")]
    })
    const r = await runProposerPass(envPair, {}, deps)
    expect(r.counts.errors).toBe(1)
    expect(r.findings).toHaveLength(1) // only entity b produced
    expect(r.counts.scanned).toBe(2)
  })

  it("produces stable fingerprints for identical input", async () => {
    const deps = buildDeps({
      listEntities: async () => [ent("contract")],
      scanDivergentRows: async () => [row("rA"), row("rB")]
    })
    const a = await runProposerPass(envPair, {}, deps)
    const b = await runProposerPass(envPair, {}, deps)
    expect(a.findings.map((f) => f.fingerprint)).toEqual(b.findings.map((f) => f.fingerprint))
  })

  it("honours entityIds whitelist", async () => {
    const deps = buildDeps({
      listEntities: async () => [ent("a"), ent("b"), ent("c")],
      scanDivergentRows: async () => [row("r")]
    })
    const r = await runProposerPass(envPair, { entityIds: ["b"] }, deps)
    expect(r.counts.scanned).toBe(1)
    expect(r.findings[0]!.entityType).toBe("b")
  })

  it("emits ProposalKind.New when row is missing on target", async () => {
    const deps = buildDeps({
      listEntities: async () => [ent("contract")],
      scanDivergentRows: async () => [row("rNew", { newOnTarget: true })]
    })
    const r = await runProposerPass(envPair, {}, deps)
    expect(r.findings[0]!.kind).toBe(ProposalKind.New)
    expect(r.findings[0]!.detail.kind).toBe("new")
  })
})
