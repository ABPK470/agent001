/**
 * Phase 7 — mustache-lite prompt templating. Verifies the substitution
 * semantics (whitespace tolerance, unknown tokens preserved, missing
 * catalog → placeholder fallback) without standing up a real catalog.
 */
import { beforeEach, describe, expect, it } from "vitest"
import { resetTenantConfig, setTenantConfig } from "../src/application/shell/tenant-config.js"
import {
    _resetPromptVarsCache,
    buildPromptVars,
    renderPromptVars,
} from "../src/loop/prompt-vars.js"

describe("renderPromptVars — substitution semantics", () => {
  beforeEach(() => {
    _resetPromptVarsCache()
    resetTenantConfig()
  })

  it("substitutes a single {{key}}", () => {
    const out = renderPromptVars("touch {{mirrorSchema}} please", { mirrorSchema: "myMirror" })
    expect(out).toBe("touch myMirror please")
  })

  it("tolerates whitespace inside the braces", () => {
    const out = renderPromptVars("hi {{  mirrorSchema  }} world", { mirrorSchema: "X" })
    expect(out).toBe("hi X world")
  })

  it("leaves unknown {{tokens}} untouched (surfaces typos)", () => {
    const out = renderPromptVars("known={{mirrorSchema}}, unknown={{noSuchThing}}", { mirrorSchema: "Y" })
    expect(out).toBe("known=Y, unknown={{noSuchThing}}")
  })

  it("substitutes every occurrence", () => {
    const out = renderPromptVars("{{mirrorSchema}}-{{mirrorSchema}}", { mirrorSchema: "ms" })
    expect(out).toBe("ms-ms")
  })
})

describe("buildPromptVars — defaults / tenant config integration", () => {
  beforeEach(() => {
    _resetPromptVarsCache()
    resetTenantConfig()
  })

  it("returns string values for every PromptVars field", () => {
    const v = buildPromptVars()
    for (const key of Object.keys(v) as (keyof typeof v)[]) {
      expect(typeof v[key], `field ${String(key)} must be a string`).toBe("string")
      expect(v[key].length, `field ${String(key)} must be non-empty`).toBeGreaterThan(0)
    }
  })

  it("picks up mirrorSchema from tenant config when set", () => {
    setTenantConfig({ mirrorSchema: "shadowSchema" })
    _resetPromptVarsCache()
    const v = buildPromptVars({ connection: "__nonexistent__" })
    expect(v.mirrorSchema).toBe("shadowSchema")
  })
})
