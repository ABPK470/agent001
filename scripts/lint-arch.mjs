#!/usr/bin/env node
/**
 * lint-arch.mjs — architecture / doctrine lint (no ESLint dependency).
 *
 * Enforces docs/doctrine.md hard edges:
 *
 *   1. Forbidden resurrected trees (application/, domain/services/, …)
 *   2. Agent layer import direction
 *   3. No module-level mutable state outside allowlists
 *   4. No new AsyncLocalStorage for DI
 *   5. Server / other packages must not deep-import agent src
 *
 * Run: `npm run lint:arch`  (or `node scripts/lint-arch.mjs`)
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(fileURLToPath(import.meta.url), "../..")
const AGENT_SRC = join(ROOT, "packages/agent/src")
const SERVER_SRC = join(ROOT, "packages/server/src")
const SYNC_SRC = join(ROOT, "packages/sync/src")
const UI_SRC = join(ROOT, "packages/ui/src")

/** Top-level agent layers with an import policy. */
const LAYERS = new Set([
  "domain",
  "core",
  "runtime",
  "ports",
  "tools",
  "llm",
  "memory",
  "internal",
])

/**
 * Allowed target layers for each source layer.
 * Intra-layer imports are always allowed.
 */
const ALLOWED = {
  domain: new Set(["domain"]),
  core: new Set(["domain", "ports", "tools", "internal"]),
  runtime: new Set([
    "core",
    "domain",
    "ports",
    "tools",
    "llm",
    "memory",
    "internal",
  ]),
  ports: new Set(["domain", "internal"]),
  tools: new Set(["domain", "core", "runtime", "ports", "internal"]),
  llm: new Set(["domain", "internal"]),
  memory: new Set(["domain", "internal"]),
  internal: new Set(["internal"]),
}

/**
 * Known transitional debt. Key = `${fromRel}→${toLayer}` or
 * `${fromRel}→${toRelPrefix}`. Prefer shrinking this list.
 */
const LAYER_ALLOWLIST = [
  // domain types still name loop/tool shapes owned elsewhere
  {
    from: "domain/types/agent-loop-state.ts",
    toPrefix: "core/",
    note: "CircuitBreaker type; move type to domain or ports when safe",
  },
  {
    from: "domain/types/agent-loop-state.ts",
    toPrefix: "tools/",
    note: "Tool loop state shapes; move to domain/types when safe",
  },
  {
    from: "domain/tenant/known-vocabulary.ts",
    toPrefix: "tools/",
    note: "Catalog graph vocabulary; keep allowlisted until domain owns the type",
  },
  // core plan still calls runtime/delegate validation helpers (should become core)
  {
    fromPrefix: "core/plan/",
    toPrefix: "runtime/delegate",
    note: "Delegate validation/escalation purity debt — migrate into core/",
  },
]

/** Trees that must not exist under packages/agent/src. */
const FORBIDDEN_AGENT_TREES = [
  "application",
  "domain/services",
  "concepts",
  "contracts",
  "decisions",
  "engine",
]

/** Files allowed to hold module-level mutable state (`let`/`var`). */
const STATE_ALLOWLIST = new Set([
  // intentional process-wide tenant knobs (const record + mutators)
  "domain/tenant/tenant-config.ts",
])

/** Module-load timers allowed (cleanup must still be reachable). */
const TIMER_ALLOWLIST = new Set([
  // browse session cleanup historically started at load; keep until host owns it
  "tools/browse-web/session.ts",
])

const errors = []
function fail(file, line, rule, detail) {
  errors.push({ file, line, rule, detail })
}

function walk(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walk(full))
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(full)
  }
  return out
}

function layerOf(relPath) {
  const head = relPath.split("/")[0]
  return LAYERS.has(head) ? head : null
}

function isLayerAllowlisted(fromRel, toRel) {
  for (const a of LAYER_ALLOWLIST) {
    if (a.from && a.from !== fromRel) continue
    if (a.fromPrefix && !fromRel.startsWith(a.fromPrefix)) continue
    if (a.toPrefix && !toRel.startsWith(a.toPrefix)) continue
    return a
  }
  return null
}

function resolveImportTarget(importerFile, spec) {
  // Strip .js → try .ts; also try as directory index
  const importerDir = importerFile.split("/").slice(0, -1).join("/")
  const raw = resolve(importerDir, spec)
  const candidates = [
    raw,
    raw.replace(/\.js$/, ".ts"),
    raw.replace(/\.js$/, ".tsx"),
    join(raw, "index.ts"),
    join(raw.replace(/\.js$/, ""), "index.ts"),
  ]
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c
  }
  // Fall back to normalized .ts path for relative reporting even if missing
  return raw.replace(/\.js$/, ".ts")
}

// ── Rule 1: forbidden trees ─────────────────────────────────────
function lintForbiddenTrees() {
  for (const tree of FORBIDDEN_AGENT_TREES) {
    const abs = join(AGENT_SRC, tree)
    if (existsSync(abs)) {
      fail(abs, 0, "forbidden-tree",
        `doctrine forbids packages/agent/src/${tree}/ — see docs/doctrine.md`)
    }
  }
}

// ── Rule 2: layer imports ───────────────────────────────────────
function lintLayerImports(file, src) {
  const fromRel = relative(AGENT_SRC, file)
  const fromLayer = layerOf(fromRel)
  if (!fromLayer) return

  const lines = src.split("\n")
  const importRe = /(?:import|export)\s+(?:type\s+)?(?:[^"'`;]+?\s+from\s+)?["']([^"']+)["']/g

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // skip block-comment-only lines
    if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue
    importRe.lastIndex = 0
    let m
    while ((m = importRe.exec(line)) !== null) {
      const spec = m[1]
      if (!spec.startsWith(".")) continue
      const targetAbs = resolveImportTarget(file, spec)
      const toRel = relative(AGENT_SRC, targetAbs)
      if (toRel.startsWith("..")) continue
      const toLayer = layerOf(toRel)
      if (!toLayer || toLayer === fromLayer) continue

      const allowed = ALLOWED[fromLayer]
      if (allowed?.has(toLayer)) continue

      const debt = isLayerAllowlisted(fromRel, toRel)
      if (debt) continue

      fail(file, i + 1, "layer-import",
        `${fromLayer} may not import ${toLayer} ("${spec}" → ${toRel}). ` +
          `Allowed from ${fromLayer}: ${[...allowed].join(", ") || "(none)"}. ` +
          `See docs/doctrine.md`)
    }
  }
}

// ── Rule 3: module-level mutable state ──────────────────────────
function lintModuleState(file, src) {
  const rel = relative(AGENT_SRC, file)
  if (STATE_ALLOWLIST.has(rel)) return
  const lines = src.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.length === 0 || /^\s/.test(line)) continue
    if (line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) continue

    if (/^(export\s+)?let\s+\w/.test(line)) {
      fail(file, i + 1, "no-module-let",
        `top-level "let" — state belongs on AgentHost / RunContext (or tenant-config allowlist)`)
    }
    if (/^(export\s+)?var\s+\w/.test(line)) {
      fail(file, i + 1, "no-module-var",
        `top-level "var" declaration at module scope`)
    }
    if (!TIMER_ALLOWLIST.has(rel)) {
      if (
        /^(const|let)\s+\w[\w\d_]*\s*=\s*setInterval\s*\(/.test(line) ||
        /^setInterval\s*\(/.test(line)
      ) {
        fail(file, i + 1, "no-module-setInterval",
          `setInterval at module load (move to AgentHost / runtime lifecycle)`)
      }
      if (
        /^(const|let)\s+\w[\w\d_]*\s*=\s*setTimeout\s*\(/.test(line) ||
        /^setTimeout\s*\(/.test(line)
      ) {
        fail(file, i + 1, "no-module-setTimeout",
          `setTimeout at module load (move to AgentHost / runtime lifecycle)`)
      }
    }
    if (/^export\s+function\s+(get|set|reset)Global[A-Z]/.test(line)) {
      const name = line.match(/(get|set|reset)Global[A-Za-z]+/)?.[0]
      fail(file, i + 1, "no-global-getter-setter",
        `exported "${name}" — thread state via AgentHost / RunContext`)
    }
  }
}

// ── Rule 4: AsyncLocalStorage for DI ────────────────────────────
function lintNoAls(file, src) {
  const lines = src.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue
    if (/new\s+AsyncLocalStorage\b/.test(line)) {
      fail(file, i + 1, "no-async-local-storage",
        `AsyncLocalStorage is forbidden for DI — pass host/context as parameters`)
    }
  }
}

// ── Rule 5: no deep imports into agent src ──────────────────────
function lintNoDeepAgentImports(pkgSrc, pkgLabel) {
  if (!existsSync(pkgSrc)) return
  for (const file of walk(pkgSrc)) {
    const src = readFileSync(file, "utf8")
    const lines = src.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (/^\s*\/\//.test(line)) continue
      // relative reach into packages/agent/src
      if (/packages\/agent\/src\//.test(line) && /from\s+["']/.test(line)) {
        fail(file, i + 1, "no-deep-agent-import",
          `${pkgLabel} must import "@mia/agent", not packages/agent/src/**`)
      }
      // bare deep path alias style
      if (/from\s+["']@mia\/agent\/src\//.test(line)) {
        fail(file, i + 1, "no-deep-agent-import",
          `${pkgLabel} must import "@mia/agent", not @mia/agent/src/**`)
      }
    }
  }
}

// ── Run ─────────────────────────────────────────────────────────
lintForbiddenTrees()

const agentFiles = walk(AGENT_SRC)
for (const f of agentFiles) {
  const src = readFileSync(f, "utf8")
  lintLayerImports(f, src)
  lintModuleState(f, src)
  lintNoAls(f, src)
}

lintNoDeepAgentImports(SERVER_SRC, "server")
lintNoDeepAgentImports(SYNC_SRC, "sync")
lintNoDeepAgentImports(UI_SRC, "ui")

if (errors.length === 0) {
  console.log(`lint-arch: ${agentFiles.length} agent files OK (${LAYER_ALLOWLIST.length} debt allowlists).`)
  process.exit(0)
}

console.error(`lint-arch: ${errors.length} violation(s):\n`)
const grouped = new Map()
for (const e of errors) {
  const key = relative(ROOT, e.file)
  if (!grouped.has(key)) grouped.set(key, [])
  grouped.get(key).push(e)
}
for (const [file, items] of grouped) {
  console.error(`  ${file}`)
  for (const e of items) {
    const loc = e.line ? `L${e.line}` : "   "
    console.error(`    ${loc}  [${e.rule}]  ${e.detail}`)
  }
}
console.error(`\nDoctrine: docs/doctrine.md`)
process.exit(1)
