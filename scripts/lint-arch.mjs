#!/usr/bin/env node
/**
 * lint-arch.mjs — architecture lint for `packages/agent/src/`.
 *
 * Enforces, with no external dependencies:
 *
 *   1. CLUSTER DOORS
 *      Files outside cluster `<X>/` may not import deep into `<X>/`. Only
 *      `<X>/index.js` is importable from the outside.
 *
 *   2. NO MODULE-LEVEL MUTABLE STATE outside designated runtime files
 *      Bans top-level `let` / `var`. Bans top-level `setInterval` /
 *      `setTimeout`. Bans exported `getGlobal*` / `setGlobal*` symbols.
 *      Allow-listed files (Phase 2b migration targets) keep working.
 *
 *   3. SERVER MAY NOT REACH INTO AGENT INTERNALS
 *      `packages/server/**` may only import `@mia/agent`, never
 *      `packages/agent/src/**`.
 *
 * Run with: `node scripts/lint-arch.mjs`
 * Exits non-zero on any violation. Designed to slot into CI and pre-commit.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(fileURLToPath(import.meta.url), "../..")
const AGENT_SRC = join(ROOT, "packages/agent/src")
const SERVER_SRC = join(ROOT, "packages/server/src")

// Clusters that own a public `index.ts` door.
const CLUSTERS = new Set([
  "context", "recovery", "delegation", "governance", "tool-helpers",
  "loop", "llm", "tools", "sync", "internal", "engine", "planner",
])

// Files that are allowed to hold module-level state. The only legitimate
// owner is `agent-runtime.ts`. Every other file's state must live inside a
// `const _state = { ... }` record so this lint stays clean.
const STATE_ALLOWLIST = new Set([
  "agent-runtime.ts",
])

// File-level allow-list overrides for setInterval / setTimeout at module load.
// `tools/browse-web/session.ts` calls `startBrowseSessionCleanup()` once at
// load so existing callers keep working; the timer can be torn down by
// `stopBrowseSessionCleanup()` (used by AgentRuntime.dispose() in future).
const TIMER_ALLOWLIST = new Set([
  "tools/browse-web/session.ts",
])

const errors = []
function fail(file, line, rule, detail) {
  errors.push({ file, line, rule, detail })
}

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walk(full))
    else if (name.endsWith(".ts")) out.push(full)
  }
  return out
}

function clusterOf(relPath) {
  const head = relPath.split("/")[0]
  return CLUSTERS.has(head) ? head : null
}

// ── Rule 1: cluster doors ───────────────────────────────────────────
function lintClusterDoors(file, src) {
  const rel = relative(AGENT_SRC, file)
  const owner = clusterOf(rel)
  const lines = src.split("\n")
  const importRe = /from\s+["']([^"']+)["']/g
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let m
    while ((m = importRe.exec(line)) !== null) {
      const spec = m[1]
      // Only relative imports
      if (!spec.startsWith(".")) continue
      // Resolve relative to file
      const importerDir = file.split("/").slice(0, -1).join("/")
      const targetAbs = resolve(importerDir, spec)
      const targetRel = relative(AGENT_SRC, targetAbs)
      if (targetRel.startsWith("..")) continue // outside agent src
      const targetCluster = clusterOf(targetRel)
      if (!targetCluster) continue
      if (targetCluster === owner) continue // intra-cluster: allowed
      // Cross-cluster: target must be `<cluster>/index.js`
      const tail = targetRel.slice(targetCluster.length + 1) // after "<cluster>/"
      if (tail !== "index.js" && tail !== "index") {
        fail(file, i + 1, "cluster-door",
          `cross-cluster import of "${spec}" must go through "${targetCluster}/index.js"`)
      }
    }
  }
}

// ── Rule 2: no module-level mutable state ──────────────────────────
// Heuristic: a line is "module-level" iff it has zero leading whitespace.
// All function/class/block bodies in this codebase are indented, so this
// avoids false positives from braces inside regex literals.
function lintModuleState(file, src) {
  const rel = relative(AGENT_SRC, file)
  if (STATE_ALLOWLIST.has(rel)) return
  const lines = src.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.length === 0 || /^\s/.test(line)) continue // not at column 0
    if (line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) continue
    if (/^(export\s+)?let\s+\w/.test(line)) {
      fail(file, i + 1, "no-module-let",
        `top-level "let" declaration at module scope (state must live in AgentRuntime)`)
    }
    if (/^(export\s+)?var\s+\w/.test(line)) {
      fail(file, i + 1, "no-module-var",
        `top-level "var" declaration at module scope`)
    }
    if (!TIMER_ALLOWLIST.has(rel)) {
      if (/^(const|let)\s+\w[\w\d_]*\s*=\s*setInterval\s*\(/.test(line) ||
          /^setInterval\s*\(/.test(line)) {
        fail(file, i + 1, "no-module-setInterval",
          `setInterval at module load (move to AgentRuntime lifecycle)`)
      }
      if (/^(const|let)\s+\w[\w\d_]*\s*=\s*setTimeout\s*\(/.test(line) ||
          /^setTimeout\s*\(/.test(line)) {
        fail(file, i + 1, "no-module-setTimeout",
          `setTimeout at module load (move to AgentRuntime lifecycle)`)
      }
    }
    if (/^export\s+function\s+(get|set|reset)Global[A-Z]/.test(line)) {
      const name = line.match(/(get|set|reset)Global[A-Za-z]+/)?.[0]
      fail(file, i + 1, "no-global-getter-setter",
        `exported "${name}" — the singleton pattern is forbidden; thread state via AgentRuntime`)
    }
  }
}

// ── Rule 3: server may not reach into agent internals ──────────────
function lintServerImports() {
  if (!safeStat(SERVER_SRC)) return
  for (const file of walk(SERVER_SRC)) {
    const src = readFileSync(file, "utf8")
    const lines = src.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/from\s+["'](\.\.\/.*?packages\/agent\/src\/[^"']+)["']/)
      if (m) {
        fail(file, i + 1, "server-no-agent-internals",
          `server must not import from packages/agent/src/** — use "@mia/agent": ${m[1]}`)
      }
    }
  }
}

function safeStat(p) {
  try { return statSync(p) } catch { return null }
}

// ── Run ────────────────────────────────────────────────────────────
const agentFiles = walk(AGENT_SRC)
for (const f of agentFiles) {
  const src = readFileSync(f, "utf8")
  lintClusterDoors(f, src)
  lintModuleState(f, src)
}
lintServerImports()

if (errors.length === 0) {
  console.log(`lint-arch: ${agentFiles.length} files OK.`)
  process.exit(0)
}
console.error(`lint-arch: ${errors.length} violation(s):\n`)
const grouped = new Map()
for (const e of errors) {
  const key = `${relative(ROOT, e.file)}`
  if (!grouped.has(key)) grouped.set(key, [])
  grouped.get(key).push(e)
}
for (const [file, items] of grouped) {
  console.error(`  ${file}`)
  for (const e of items) {
    console.error(`    L${e.line}  [${e.rule}]  ${e.detail}`)
  }
}
process.exit(1)
