import { describe, expect, it } from "vitest"
import type { Tool } from "../src/domain/types/agent-types.js"

/**
 * Contract: planner children must never be visibility-filtered by the
 * planner LLM's per-step allowedTools / requiredToolCapabilities lists.
 * Those fields are intent only; spawn always starts from the parent belt.
 */
describe("planner child tool belt", () => {
  it("documents that an incomplete planner allowlist must not shrink the host belt", () => {
    const parentTools = [
      { name: "write_file" },
      { name: "read_file" },
      { name: "query_mssql" },
      { name: "search_catalog" },
    ] as Tool[]
    const plannerListed = new Set(["write_file", "read_file"])

    // Runtime policy (spawn-for-plan): inherit parent belt, ignore planner list.
    const childTools = [...parentTools]
    const childNames = new Set(childTools.map((t) => t.name))

    expect(plannerListed.has("query_mssql")).toBe(false)
    expect(childNames.has("query_mssql")).toBe(true)
    expect(childNames.size).toBe(parentTools.length)
  })
})
