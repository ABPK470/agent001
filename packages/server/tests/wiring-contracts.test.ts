/**
 * Wiring-contract tests — catch cross-callsite drift bugs that module
 * tests are structurally blind to.
 *
 * The bug class these target: "two callsites must agree on the same key
 * or expression, but each one is in a different module." Module tests
 * verify each module in isolation, so the contract between them can
 * silently drift during refactors. Example: ingestion writes by
 * `activeRun.sessionId` but retrieval reads by `agentId ?? "default"`
 * (the bug we just shipped).
 *
 * Strategy: parse source files as TEXT (no AST — keep it simple), extract
 * call expressions for paired functions, and assert the agreed-on
 * expressions match.
 *
 * Why text-scanning instead of "just write a real test that uses both
 * modules"? Because the production code site that decides what to pass
 * to each module IS the bug surface. A test that sets up both modules
 * with consistent inputs cannot catch a production caller that uses
 * inconsistent inputs.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))
const SERVER_ROOT = join(here, "..")
const SRC_ROOT = join(SERVER_ROOT, "src")
const RUN_EXECUTOR_ENVIRONMENT = join(
  SRC_ROOT,
  "features",
  "runs",
  "execution",
  "run-executor",
  "environment.ts"
)
const RUN_EXECUTOR_TOOLS = join(SRC_ROOT, "features", "runs", "execution", "run-executor", "tools.ts")
const RUN_EXECUTOR_HOST = join(SRC_ROOT, "features", "runs", "execution", "run-executor", "host.ts")
const RUN_EXECUTOR_FINALIZATION = join(
  SRC_ROOT,
  "features",
  "runs",
  "execution",
  "run-executor",
  "finalization.ts"
)

// ── Shared helpers ────────────────────────────────────────────────

interface CallSite {
  /** Raw text inside the outermost {...} */
  body: string
  /** Map of field name → expression text (best-effort, simple cases only). */
  fields: Map<string, string>
  /** 1-based line number of the call (for error messages). */
  line: number
}

/**
 * Extract every `{ ... }` object-literal argument passed to `fnName`.
 * Handles single-arg-object calls like `fnName({ a: 1, b: 2 })` and
 * `fnName(arg1, { a: 1 })` — finds the LAST {...} balanced block in
 * the call's argument list.
 */
function extractObjectArgCalls(src: string, fnName: string): CallSite[] {
  const results: CallSite[] = []
  const re = new RegExp(`\\b${fnName}\\s*\\(`, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const openIdx = m.index + m[0].length - 1
    // Find matching closing paren
    let depth = 1
    let i = openIdx + 1
    while (i < src.length && depth > 0) {
      const c = src[i]
      if (c === "(") depth++
      else if (c === ")") depth--
      else if (c === '"' || c === "'" || c === "`") {
        // skip string literal
        const quote = c
        i++
        while (i < src.length) {
          if (src[i] === "\\") {
            i += 2
            continue
          }
          if (src[i] === quote) break
          i++
        }
      }
      i++
    }
    const argsText = src.slice(openIdx + 1, i - 1)

    // Find the LAST top-level { ... } in argsText.
    let braceStart = -1
    let braceDepth = 0
    let lastBraceStart = -1
    let lastBraceEnd = -1
    for (let j = 0; j < argsText.length; j++) {
      const ch = argsText[j]
      if (ch === "{") {
        if (braceDepth === 0) braceStart = j
        braceDepth++
      } else if (ch === "}") {
        braceDepth--
        if (braceDepth === 0) {
          lastBraceStart = braceStart
          lastBraceEnd = j
        }
      }
    }
    if (lastBraceStart < 0) continue
    const body = argsText.slice(lastBraceStart + 1, lastBraceEnd)
    const fields = parseFields(body)
    const line = src.slice(0, m.index).split("\n").length
    results.push({ body, fields, line })
  }
  return results
}

/**
 * Parse top-level fields from an object-literal body.
 * Handles `id: x`, `id: x ?? y ?? "z"`, `id`, etc.
 * Skips nested objects/arrays/parens.
 */
function parseFields(body: string): Map<string, string> {
  const out = new Map<string, string>()
  // Walk the body, splitting on commas at depth 0 only.
  const segments: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === "(" || c === "[" || c === "{") depth++
    else if (c === ")" || c === "]" || c === "}") depth--
    else if (c === '"' || c === "'" || c === "`") {
      const q = c
      i++
      while (i < body.length) {
        if (body[i] === "\\") {
          i += 2
          continue
        }
        if (body[i] === q) break
        i++
      }
    } else if (c === "," && depth === 0) {
      segments.push(body.slice(start, i))
      start = i + 1
    }
  }
  segments.push(body.slice(start))

  for (const seg of segments) {
    const trimmed = seg.trim()
    if (!trimmed) continue
    if (trimmed.startsWith("//")) continue
    if (trimmed.startsWith("...")) continue
    // Match `name: expr` or `name`.
    const m = trimmed.match(/^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/)
    if (m) {
      out.set(m[1], m[2].trim())
    } else {
      const shorthand = trimmed.match(/^([A-Za-z_$][\w$]*)$/)
      if (shorthand) out.set(shorthand[1], shorthand[1])
    }
  }
  return out
}

function readSrc(absPath: string): string {
  return readFileSync(absPath, "utf8")
}

// ── B1 — sessionId pair lock (memory write/read) ─────────────────

describe("Wiring contracts: memory write↔read pair on sessionId", () => {
  it("B1: every retrieveContext + ingestRunTurns sessionId expression references activeRun?.sessionId", () => {
    const retrieveSrc = readSrc(RUN_EXECUTOR_TOOLS)
    const ingestSrc = readSrc(RUN_EXECUTOR_FINALIZATION)
    const retrieveCalls = extractObjectArgCalls(retrieveSrc, "retrieveContext")
    const ingestCalls = extractObjectArgCalls(ingestSrc, "ingestRunTurns")

    expect(
      retrieveCalls.length,
      "expected at least one retrieveContext call in run-executor.ts"
    ).toBeGreaterThan(0)
    expect(
      ingestCalls.length,
      "expected at least one ingestRunTurns call in run-executor.ts"
    ).toBeGreaterThan(0)

    const ANCHOR = "activeRun?.sessionId"
    for (const c of retrieveCalls) {
      const expr = c.fields.get("sessionId")
      expect(expr, `retrieveContext at line ${c.line} must specify sessionId`).toBeDefined()
      expect(
        expr,
        `retrieveContext at line ${c.line}: sessionId expression must reference ${ANCHOR}`
      ).toContain(ANCHOR)
    }
    for (const c of ingestCalls) {
      const expr = c.fields.get("sessionId")
      expect(expr, `ingestRunTurns at line ${c.line} must specify sessionId`).toBeDefined()
      expect(
        expr,
        `ingestRunTurns at line ${c.line}: sessionId expression must reference ${ANCHOR}`
      ).toContain(ANCHOR)
    }
  })
})

// ── B2 — upn pair lock ───────────────────────────────────────────

describe("Wiring contracts: memory write↔read pair on upn", () => {
  it("B2: every retrieveContext + ingestRunTurns upn expression references activeRun?.ownerUpn", () => {
    const retrieveSrc = readSrc(RUN_EXECUTOR_TOOLS)
    const ingestSrc = readSrc(RUN_EXECUTOR_FINALIZATION)
    const retrieveCalls = extractObjectArgCalls(retrieveSrc, "retrieveContext")
    const ingestCalls = extractObjectArgCalls(ingestSrc, "ingestRunTurns")

    const ANCHOR = "activeRun?.ownerUpn"
    for (const c of retrieveCalls) {
      const expr = c.fields.get("upn")
      expect(expr, `retrieveContext at line ${c.line} must specify upn`).toBeDefined()
      expect(expr, `retrieveContext at line ${c.line}: upn expression must reference ${ANCHOR}`).toContain(
        ANCHOR
      )
    }
    for (const c of ingestCalls) {
      const expr = c.fields.get("upn")
      expect(expr, `ingestRunTurns at line ${c.line} must specify upn`).toBeDefined()
      expect(expr, `ingestRunTurns at line ${c.line}: upn expression must reference ${ANCHOR}`).toContain(
        ANCHOR
      )
    }
  })
})

// ── B3 — runId pair lock (excludeRunId at retrieve must equal runId at ingest) ──

describe("Wiring contracts: memory write↔read pair on runId / excludeRunId", () => {
  it("B3: retrieveContext.runId equals the runId variable that ingestRunTurns.id uses", () => {
    const retrieveSrc = readSrc(RUN_EXECUTOR_TOOLS)
    const ingestSrc = readSrc(RUN_EXECUTOR_FINALIZATION)
    const retrieveCalls = extractObjectArgCalls(retrieveSrc, "retrieveContext")
    const ingestCalls = extractObjectArgCalls(ingestSrc, "ingestRunTurns")

    // retrieveContext.runId is used as excludeRunId in retrieval — must
    // refer to the SAME identifier that ingestRunTurns writes as `id`.
    // We don't enforce a literal name; we just assert that whatever name
    // each side uses is identical, so a future rename moving one and not
    // the other fails this test.
    const retrieveRunIds = new Set(retrieveCalls.map((c) => c.fields.get("runId")))
    const ingestIds = new Set(ingestCalls.map((c) => c.fields.get("id")))

    expect(retrieveRunIds.size, "all retrieveContext calls must use the same runId expression").toBe(1)
    expect(ingestIds.size, "all ingestRunTurns calls must use the same id expression").toBe(1)
    expect([...retrieveRunIds][0]).toBe([...ingestIds][0])
  })
})

// ── B4 — extractProcedural + searchProcedures pair on sessionId/upn ──

describe("Wiring contracts: procedural memory pair on sessionId/upn", () => {
  it("B4: extractProcedural sessionId/upn expressions match the memory write/read anchors", () => {
    const src = readSrc(RUN_EXECUTOR_FINALIZATION)
    const calls = extractObjectArgCalls(src, "extractProcedural")
    expect(calls.length, "expected extractProcedural call(s) in run-executor.ts").toBeGreaterThan(0)

    for (const c of calls) {
      const sid = c.fields.get("sessionId")
      const upn = c.fields.get("upn")
      expect(sid, `extractProcedural at line ${c.line} must specify sessionId`).toBeDefined()
      expect(upn, `extractProcedural at line ${c.line} must specify upn`).toBeDefined()
      expect(sid, `extractProcedural sessionId must reference activeRun?.sessionId`).toContain(
        "activeRun?.sessionId"
      )
      expect(upn, `extractProcedural upn must reference activeRun?.ownerUpn`).toContain("activeRun?.ownerUpn")
    }
  })
})

// ── B5 — HostedPolicyContext + memory call alignment ──────────────

describe("Wiring contracts: HostedPolicyContext fields match memory call anchors", () => {
  it("B5: HostedPolicyContext actorUpn/sessionId references activeRun fields, same as memory calls", () => {
    const src = readSrc(RUN_EXECUTOR_HOST)
    const m = src.match(/function createPolicyContext\([\s\S]*?return \{([\s\S]*?)\n\s*\}/)
    expect(m, "expected createPolicyContext() to return a HostedPolicyContext object literal").not.toBeNull()
    const fields = parseFields(m![1])
    const actorUpn = fields.get("actorUpn")
    const sid = fields.get("sessionId")
    expect(actorUpn, "HostedPolicyContext.actorUpn must be present").toBeDefined()
    expect(sid, "HostedPolicyContext.sessionId must be present").toBeDefined()
    expect(actorUpn, "policy actorUpn must reference activeRun?.ownerUpn (same anchor as memory)").toContain(
      "activeRun?.ownerUpn"
    )
    expect(sid, "policy sessionId must reference activeRun?.sessionId (same anchor as memory)").toContain(
      "activeRun?.sessionId"
    )
  })
})

// ── B-AUDIT — codebase-wide scan for the antipattern ─────────────

/**
 * The killer test. Scans ALL .ts files under packages/server/src for
 * identifiers being silently defaulted to a magic string in a position
 * that should be a session/user/agent identifier. Existing legitimate
 * hits are listed in the inline allowlist below with a 1-line reason.
 *
 * If a future refactor introduces a new `?? "default"` (or similar) on
 * an identifier field, this test fails with the file:line and forces
 * the developer to either fix the code or justify the fallback by
 * adding it to the allowlist with a reason.
 *
 * The allowlist is intentionally inline (not a separate JSON) so any
 * change is visible in the same PR diff.
 */

interface AllowlistEntry {
  /** Substring of file path (matched as endsWith). */
  file: string
  /** Substring of the matching line text (matched as includes). */
  match: string
  /** WHY this fallback is acceptable. Required. */
  reason: string
}

const AUDIT_ALLOWLIST: AllowlistEntry[] = [
  // ── Memory keying chain (the C9/D3 open question) ────────────────
  // The fix shipped in run-executor.ts:303 — sessionId reads now correctly
  // align with writes via the activeRun?.sessionId anchor; the agentId
  // fallback exists for service-internal runs where activeRun is absent.
  // The "default" tail is the legacy global anonymous bucket; flagged for
  // the C9 invariant — see plan-test-coverage-deepening.md D3.
  {
    file: "memory/ingestion.ts",
    match: 'run.sessionId ?? run.agentId ?? "default"',
    reason:
      "Memory write fallback chain — the contract that retrieval mirrors. Tail 'default' bucket is the C9/D3 open question."
  },

  // ── Audit log display strings (display-only, NOT isolation keys) ─
  // These flow into audit log rows as a human-readable "who did this"
  // field. Multiple unauthenticated callers sharing the literal "unknown"
  // or "anonymous" is OK because audit rows are never used as a JOIN key
  // for tenancy filtering — they only render as a string in the UI.
  // (Verified: db/audit_log table uses these only as display text.)
  {
    file: "db/sync-runs.ts",
    match: 'i.actorUpn ?? "anonymous"',
    reason:
      "actor_upn column on sync_runs is display-only for the history UI; isolation is enforced by separate fk/owner columns."
  },
  {
    file: "api/policies.ts",
    match: 'req.session?.upn ?? "unknown"',
    reason: "Audit log actor field — display-only, not used as a tenancy/key column."
  },
  {
    file: "api/sync-environments.ts",
    match: 'req.session?.upn ?? "unknown"',
    reason: "Audit log actor field — display-only, not used as a tenancy/key column."
  },
  {
    file: "api/freeze-windows.ts",
    match: 'req.session?.upn ?? "unknown"',
    reason:
      "Audit log actor field — display-only, not used as a tenancy/key column. Sibling of routes/policies.ts and routes/sync-environments.ts."
  },
  {
    file: "api/sync.ts",
    match: 'req.session?.upn ?? req.session?.displayName ?? "anonymous"',
    reason:
      "Audit log actor display string only. Real isolation uses actorUpn (which stays null) on the same call sites."
  },

  // ── False positive: bounded by upn predicate ─────────────────────
  // The dedup recent-rows query uses `sessionId ?? ""` as a SQL bind
  // parameter alongside `upn = ?` in the WHERE clause. Empty-string
  // collisions across anonymous users are bounded by the upn predicate
  // (each tenant has its own anon bucket), so dedup remains correct
  // per-tenant. Documented at memory/ingestion.ts:46-52.
  {
    file: "memory/ingestion.ts",
    match: 'opts.sessionId ?? ""',
    reason:
      "SQL bind parameter for dedup recency query; bounded by upn predicate so cross-anon collisions don't leak data."
  }

  // ── B-AUDIT history (resolved 2026-05-15) ────────────────────────
  //
  // Three sibling bugs of the original "yes had no context" pattern were
  // surfaced by B-AUDIT and FIXED rather than allowlisted, because the
  // identity contract guarantees they were unreachable defensive code:
  //
  //   identity.ts:resolveSession() runs in an onRequest hook BEFORE any
  //   handler and ALWAYS sets req.session.sid via one of three guaranteed-
  //   non-empty paths (header / signed cookie / `anon:<random>` minted on
  //   first contact and persisted as a cookie). Therefore every downstream
  //   `req.session?.sid ?? "anon"` was dead code masking the real contract.
  //
  //   1. index.ts SSE handler — dropped `?.` and `?? "anon"`; now reads
  //      `req.session.sid` directly so a missing session surfaces loudly.
  //
  //   2. routes/layouts.ts:dashboardIdFor — narrowed the param type to
  //      require `session: CurrentSession` and dropped `?? "anon"`. The
  //      `s.upn ?? s.sid` chain is intentional (dev = no upn → use sid).
  //
  //   3. tool-cache.ts:safeSessionDir — tightened signature from
  //      `string | null | undefined` to `string` and now throws on empty
  //      ids instead of silently sharing an "anonymous" partition. All
  //      public exports (readCache/writeCache/getOrCompute/
  //      clearSessionCache) were narrowed accordingly; the route layer
  //      already pre-guards null targets.
  //
  // If a similar pattern reappears, prefer fixing (propagate the
  // identifier or fail loudly) over allowlisting.
]

describe("Wiring contracts: B-AUDIT — codebase-wide identifier-fallback scan", () => {
  it("B-AUDIT: no NEW silent defaults to magic strings on identifier fields", async () => {
    const { readdirSync, statSync } = await import("node:fs")

    // ONLY flag fallbacks that coerce an identifier to a STRING LITERAL.
    // We deliberately do not flag `?? null` because that is the standard
    // DB-column normalisation pattern (undefined → SQL NULL); each such
    // row stays distinguishable, so it does not cause the collision bug.
    //
    // The bug class we hunt: `xxx ?? "magic"` where "magic" becomes a
    // shared bucket key — e.g. every anonymous user gets sessionId="anon",
    // collapsing all of them into one memory bucket.
    const FORBIDDEN_PATTERN =
      /\b(sessionId|upn|ownerUpn|userId|actorUpn|agentId|conversationId|sid|tenant|tenantId)\s*\?\?[^,\n)]*?["'][^"']+["']/g

    const violations: Array<{ file: string; line: number; text: string }> = []

    function walk(dir: string) {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        const stat = statSync(full)
        if (stat.isDirectory()) {
          walk(full)
        } else if (full.endsWith(".ts") && !full.endsWith(".d.ts")) {
          const text = readFileSync(full, "utf8")
          const lines = text.split("\n")
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]
            // Strip line-comments to avoid matching prose.
            const codeOnly = line.split("//")[0]
            if (FORBIDDEN_PATTERN.test(codeOnly)) {
              violations.push({ file: full, line: i + 1, text: line.trim() })
            }
            FORBIDDEN_PATTERN.lastIndex = 0
          }
        }
      }
    }

    walk(SRC_ROOT)

    // Filter out allowlisted entries.
    const unjustified = violations.filter((v) => {
      const rel = v.file.slice(SRC_ROOT.length + 1).replace(/\\/g, "/")
      return !AUDIT_ALLOWLIST.some((a) => rel.endsWith(a.file) && v.text.includes(a.match))
    })

    if (unjustified.length > 0) {
      const summary = unjustified
        .map((v) => {
          const rel = v.file.slice(SRC_ROOT.length + 1).replace(/\\/g, "/")
          return `  ${rel}:${v.line}\n    ${v.text}`
        })
        .join("\n")
      throw new Error(
        `B-AUDIT found ${unjustified.length} unjustified identifier→magic-string fallback(s):\n${summary}\n\n` +
          `Each match coerces an identifier (sessionId/upn/agentId/etc.) into a SHARED magic string\n` +
          `bucket when missing. This is the bug class that caused 'yes had no context': all\n` +
          `anonymous/unmapped callers collapse into the SAME bucket and silently share state.\n` +
          `Either fix the code to propagate the identifier (preferred) or add an entry to\n` +
          `AUDIT_ALLOWLIST in tests/wiring-contracts.test.ts with a 1-line reason.`
      )
    }
  })
})
