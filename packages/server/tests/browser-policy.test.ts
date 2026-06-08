/**
 * Domain policy evaluator: glob matching + allow/deny precedence.
 */

import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { seedTestUsers } from "./_fk-helpers.js"

let testDb: Database.Database
let dataDir: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-pol-"))
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  testDb.pragma("journal_mode = WAL")
  testDb.pragma("foreign_keys = ON")
  const { _setDb, _migrate } = await import("../src/platform/persistence/db/index.js")
  _migrate(testDb)
  _setDb(testDb)
  seedTestUsers(testDb)
})

afterEach(() => {
  testDb.close()
  rmSync(dataDir, { recursive: true, force: true })
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["MIA_DATA_DIR"]
  else process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
})

describe("browser domain policy", () => {
  it("matches exact and wildcard patterns", async () => {
    const { matchPattern } = await import("../src/features/browser/policy.js")
    expect(matchPattern("example.com", "example.com")).toBe(true)
    expect(matchPattern("example.com", "evil.com")).toBe(false)
    expect(matchPattern("*.example.com", "example.com")).toBe(true)
    expect(matchPattern("*.example.com", "a.example.com")).toBe(true)
    expect(matchPattern("*.example.com", "a.b.example.com")).toBe(true)
    expect(matchPattern("*.example.com", "evil.com")).toBe(false)
    expect(matchPattern("**", "anything.tld")).toBe(true)
  })

  it("default-allow when no rules exist", async () => {
    const { evaluatePolicy } = await import("../src/features/browser/policy.js")
    const d = evaluatePolicy("alice@x", "https://example.com/path")
    expect(d.allow).toBe(true)
  })

  it("deny rules win over allow rules", async () => {
    const { addPolicyRule, evaluatePolicy } = await import("../src/features/browser/policy.js")
    addPolicyRule({ ownerUpn: "alice@x", pattern: "*.example.com", effect: "allow" })
    addPolicyRule({
      ownerUpn: "alice@x",
      pattern: "evil.example.com",
      effect: "deny",
      reason: "phishing"
    })

    const ok = evaluatePolicy("alice@x", "https://api.example.com/x")
    expect(ok.allow).toBe(true)

    const blocked = evaluatePolicy("alice@x", "https://evil.example.com/x")
    expect(blocked.allow).toBe(false)
    expect(blocked.reason).toMatch(/phishing/)
  })

  it("allow-list flips the tenant to default-deny", async () => {
    const { addPolicyRule, evaluatePolicy } = await import("../src/features/browser/policy.js")
    addPolicyRule({ ownerUpn: "alice@x", pattern: "github.com", effect: "allow" })

    expect(evaluatePolicy("alice@x", "https://github.com/x").allow).toBe(true)
    const denied = evaluatePolicy("alice@x", "https://example.com")
    expect(denied.allow).toBe(false)
    expect(denied.reason).toMatch(/allow-list/)
  })

  it("global rules apply to every tenant", async () => {
    const { addPolicyRule, evaluatePolicy } = await import("../src/features/browser/policy.js")
    addPolicyRule({ ownerUpn: null, pattern: "*.malware.test", effect: "deny", reason: "global-deny" })

    expect(evaluatePolicy("alice@x", "https://x.malware.test").allow).toBe(false)
    expect(evaluatePolicy("bob@y", "https://x.malware.test").allow).toBe(false)
    expect(evaluatePolicy("alice@x", "https://x.com").allow).toBe(true)
  })

  it("rejects malformed URLs", async () => {
    const { evaluatePolicy } = await import("../src/features/browser/policy.js")
    const d = evaluatePolicy("alice@x", "not a url")
    expect(d.allow).toBe(false)
    expect(d.reason).toMatch(/invalid URL/)
  })
})
