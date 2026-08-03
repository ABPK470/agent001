import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { createPostgresTsvectorMemorySearch } from "./tsvector-search.js"

describe("postgres tsvector search contract", () => {
  it("exposes postgres-tsvector kind and uses simple regconfig", () => {
    expect(createPostgresTsvectorMemorySearch().kind).toBe("postgres-tsvector")
    const file = readFileSync(fileURLToPath(new URL("./tsvector-search.ts", import.meta.url)), "utf8")
    expect(file).toContain("plainto_tsquery('simple'")
    expect(file).toContain("ts_rank")
    expect(file).not.toContain("plainto_tsquery('english'")
  })
})
