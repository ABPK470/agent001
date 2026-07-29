/**
 * Knowledge packs — parse/select curated MSSQL knowledge without shipping
 * mart playbooks on metadata asks (and the reverse).
 */

import { resetTenantConfig } from "@mia/agent"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { beforeEach, describe, expect, it } from "vitest"
import {
  knowledgeBodyHasMartProse,
  knowledgeBodyHasMetaProse,
  parseKnowledgePacks,
  renderKnowledgeSelection
} from "../src/infra/mssql/knowledge-packs.js"
import {
  _resetDecideSectionsCache,
  classifyGoal,
  decideSections
} from "../src/runtime/prompting/decide-sections.js"

const KNOWLEDGE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../deploy/mssql/mymi-knowledge.md"
)

beforeEach(() => {
  resetTenantConfig()
  _resetDecideSectionsCache()
})

describe("knowledge packs (mymi-knowledge.md)", () => {
  const body = readFileSync(KNOWLEDGE_PATH, "utf-8")

  it("is marked with shared/meta/mart packs", () => {
    const packs = parseKnowledgePacks(body)
    expect(packs.marked).toBe(true)
    expect(packs.shared.length).toBeGreaterThan(100)
    expect(packs.meta.length).toBeGreaterThan(500)
    expect(packs.mart.length).toBeGreaterThan(1000)
  })

  it("meta selection excludes mart prose (publish/Revenue playbooks)", () => {
    const rendered = renderKnowledgeSelection(body, "meta")
    expect(knowledgeBodyHasMetaProse(rendered)).toBe(true)
    expect(rendered).toMatch(/\bcore\b/i)
    expect(rendered).not.toMatch(/publish\.Revenue/)
    expect(rendered).not.toMatch(/RevenueZARMTD/)
    expect(rendered.length).toBeLessThan(body.length * 0.55)
  })

  it("mart selection excludes core registry dump", () => {
    const rendered = renderKnowledgeSelection(body, "mart")
    expect(knowledgeBodyHasMartProse(rendered)).toBe(true)
    expect(rendered).toMatch(/publish/i)
    expect(rendered).not.toMatch(/Central metadata registry/)
  })

  it("header is orientation-sized and lists schemas", () => {
    const header = renderKnowledgeSelection(body, "header")
    expect(header.length).toBeLessThan(1200)
    expect(header).toMatch(/Schemas covered|Tool Orchestration|full knowledge omitted/i)
  })

  it("both is larger than meta alone", () => {
    const meta = renderKnowledgeSelection(body, "meta")
    const both = renderKnowledgeSelection(body, "both")
    expect(both.length).toBeGreaterThan(meta.length)
  })
})

describe("knowledge pack selection from goals", () => {
  it("core schema tables → meta pack, no big-table ETL", () => {
    const d = decideSections({
      goal: "what are the biggest core schema tables in dev",
      memory: { working: "", episodic: "", semantic: "" }
    })
    expect(d.frame).toBe("data_query")
    expect(d.knowledgePack).toBe("meta")
    expect(d.includeBigTableEtl).toBe(false)
    expect(d.includeMssqlKnowledge).toBe(true)
  })

  it("revenue / BI → mart pack with ETL", () => {
    const d = decideSections({
      goal: "list top 3 products based on revenue for April 2025",
      memory: { working: "", episodic: "", semantic: "" }
    })
    expect(d.knowledgePack).toBe("mart")
    expect(d.includeBigTableEtl).toBe(true)
  })

  it("publish.Revenue SQL → mart", () => {
    const c = classifyGoal("select top 10 from publish.Revenue")
    expect(c.knowledgePack).toBe("mart")
  })

  it("sync drift → meta", () => {
    const d = decideSections({
      goal: "what is out of sync between uat and dev?",
      memory: { working: "", episodic: "", semantic: "" }
    })
    expect(d.frame).toBe("sync")
    expect(d.knowledgePack).toBe("meta")
    expect(d.includeBigTableEtl).toBe(false)
  })

  it("ADO secrets stay none", () => {
    const c = classifyGoal(
      "The defaults declare secrets in an array — how should we wire that in Azure DevOps?"
    )
    expect(c.knowledgePack).toBe("none")
  })
})
