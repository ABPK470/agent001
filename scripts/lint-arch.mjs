#!/usr/bin/env node
/**
 * lint-arch.mjs — architecture / doctrine lint (no ESLint dependency).
 *
 * Enforces docs/doctrine.md hard edges for @mia/agent, @mia/server, @mia/sync:
 *
 *   Agent:
 *     1. Forbidden resurrected trees (application/, domain/services/, …)
 *     2. Layer import direction
 *     3. No module-level mutable state outside allowlists
 *     4. No new AsyncLocalStorage for DI
 *
 *   Server:
 *     5. Canonical top-level folders (boot/http/infra/adapters/api/…)
 *     6. Forbidden Nest folders under api/ + retired top-level names
 *     7. Shell layer import direction
 *
 *   Sync (rhymes with agent):
 *     8. Forbidden application/ tree
 *     9. Layer import direction (domain/core/runtime/ports/tools/adapters)
 *    10. Module-level mutable state outside allowlists
 *
 *   Cross-package:
 *    11. Other packages must not deep-import agent or sync src
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

// ── Rule 5: no deep imports into agent/sync src ─────────────────
function lintNoDeepPackageImports(pkgSrc, pkgLabel) {
  if (!existsSync(pkgSrc)) return
  for (const file of walk(pkgSrc)) {
    const src = readFileSync(file, "utf8")
    const lines = src.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (/^\s*\/\//.test(line)) continue
      if (/packages\/agent\/src\//.test(line) && /from\s+["']/.test(line)) {
        fail(file, i + 1, "no-deep-agent-import",
          `${pkgLabel} must import "@mia/agent", not packages/agent/src/**`)
      }
      if (/from\s+["']@mia\/agent\/src\//.test(line)) {
        fail(file, i + 1, "no-deep-agent-import",
          `${pkgLabel} must import "@mia/agent", not @mia/agent/src/**`)
      }
      if (/packages\/sync\/src\//.test(line) && /from\s+["']/.test(line)) {
        fail(file, i + 1, "no-deep-sync-import",
          `${pkgLabel} must import "@mia/sync", not packages/sync/src/**`)
      }
      if (/from\s+["']@mia\/sync\/src\//.test(line)) {
        fail(file, i + 1, "no-deep-sync-import",
          `${pkgLabel} must import "@mia/sync", not @mia/sync/src/**`)
      }
    }
  }
}

// ── Server: canonical layers (target names only — no aliases) ───
const SERVER_LAYER_ALIAS = {
  boot: "boot",
  http: "http",
  infra: "infra",
  adapters: "adapters",
  api: "api",
  ports: "ports",
  internal: "internal",
  cli: "cli",
}

const SERVER_ALLOWED = {
  boot: new Set(["boot", "infra", "adapters", "api", "ports", "http", "internal"]),
  http: new Set(["http", "api", "infra", "boot", "ports", "internal"]),
  api: new Set(["api", "infra", "adapters", "ports", "boot", "internal"]),
  adapters: new Set(["adapters", "infra", "ports", "internal"]),
  infra: new Set(["infra", "internal", "ports"]),
  ports: new Set(["ports", "internal"]),
  cli: new Set(["cli", "boot", "infra", "api", "internal", "adapters"]),
  internal: new Set(["internal"]),
}

/** Known reverse-edge / contract debt — shrink these. */
const SERVER_LAYER_ALLOWLIST = []

/** Trees / folder names that must not exist under packages/server/src. */
const FORBIDDEN_SERVER_TREES = [
  "crypto",
  "deploy",
  "api/deploy",
  "hosting",
  "api/runs/hosting",
  // retired top-level names — do not resurrect
  "bootstrap",
  "app",
  "features",
  "platform",
  "shared",
  "api/runs/core",
]

/** Nest-style folder names forbidden anywhere under api/ */
const FORBIDDEN_API_NEST_DIRS = ["application", "domain", "runtime", "transport"]

function serverLayerOf(relPath) {
  const head = relPath.split("/")[0]
  return SERVER_LAYER_ALIAS[head] ?? null
}

function isServerLayerAllowlisted(fromRel, toRel) {
  for (const a of SERVER_LAYER_ALLOWLIST) {
    if (a.from && a.from !== fromRel) continue
    if (a.fromPrefix && !fromRel.startsWith(a.fromPrefix)) continue
    if (a.toPrefix && !toRel.startsWith(a.toPrefix)) continue
    return a
  }
  return null
}

function lintServerForbiddenTrees() {
  for (const tree of FORBIDDEN_SERVER_TREES) {
    const abs = join(SERVER_SRC, tree)
    if (existsSync(abs)) {
      fail(abs, 0, "server-forbidden-tree",
        `doctrine forbids packages/server/src/${tree}/ — see docs/doctrine.md`)
    }
  }
  const apiRoot = join(SERVER_SRC, "api")
  if (!existsSync(apiRoot)) return
  for (const file of walk(apiRoot)) {
    const parts = relative(SERVER_SRC, file).split("/")
    for (const nest of FORBIDDEN_API_NEST_DIRS) {
      if (parts.includes(nest)) {
        fail(file, 0, "server-forbidden-tree",
          `doctrine forbids api/**/${nest}/ — use service/ | types/ | state/ | handlers/`)
        return
      }
    }
    if (parts.includes("hosting")) {
      fail(file, 0, "server-forbidden-tree",
        `doctrine forbids hosting/ — use api/runs/prompting/`)
      return
    }
    if (parts.includes("deploy")) {
      fail(file, 0, "server-forbidden-tree",
        `doctrine forbids api/**/deploy/ — use api/platform/; keep "deploy" in filenames only`)
      return
    }
  }
}

function lintServerTopLevel() {
  if (!existsSync(SERVER_SRC)) return
  const allowedHeads = new Set([
    ...Object.keys(SERVER_LAYER_ALIAS),
    "index.ts",
  ])
  for (const name of readdirSync(SERVER_SRC)) {
    if (name.startsWith(".")) continue
    const abs = join(SERVER_SRC, name)
    const st = statSync(abs)
    if (st.isFile()) {
      if (name === "index.ts") continue
      // allow stray md next to src root
      if (name.endsWith(".md")) continue
      fail(abs, 0, "server-top-level",
        `unexpected file at server src root: ${name}`)
      continue
    }
    if (!allowedHeads.has(name)) {
      fail(abs, 0, "server-top-level",
        `unknown server top-level "${name}". Allowed: boot, http, infra, adapters, api, ports, internal, cli`)
    }
  }
}

function lintServerLayerImports(file, src) {
  const fromRel = relative(SERVER_SRC, file)
  const fromLayer = serverLayerOf(fromRel)
  if (!fromLayer) return

  const lines = src.split("\n")
  const importRe = /(?:import|export)\s+(?:type\s+)?(?:[^"'`;]+?\s+from\s+)?["']([^"']+)["']/g

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue
    importRe.lastIndex = 0
    let m
    while ((m = importRe.exec(line)) !== null) {
      const spec = m[1]
      if (!spec.startsWith(".")) continue
      const targetAbs = resolveImportTarget(file, spec)
      const toRel = relative(SERVER_SRC, targetAbs)
      if (toRel.startsWith("..")) continue
      const toLayer = serverLayerOf(toRel)
      if (!toLayer || toLayer === fromLayer) continue

      const allowed = SERVER_ALLOWED[fromLayer]
      if (allowed?.has(toLayer)) continue

      const debt = isServerLayerAllowlisted(fromRel, toRel)
      if (debt) continue

      fail(file, i + 1, "server-layer-import",
        `${fromLayer} may not import ${toLayer} ("${spec}" → ${toRel}). ` +
          `Allowed from ${fromLayer}: ${[...allowed].join(", ") || "(none)"}. ` +
          `See docs/doctrine.md`)
    }
  }
}

// ── Sync: same dialect as agent ─────────────────────────────────
const SYNC_LAYERS = new Set([
  "domain",
  "core",
  "runtime",
  "ports",
  "tools",
  "adapters",
  "internal",
])

const SYNC_ALLOWED = {
  domain: new Set(["domain", "ports"]),
  core: new Set(["domain", "ports", "internal"]),
  runtime: new Set(["core", "domain", "ports", "adapters", "internal", "tools"]),
  ports: new Set(["domain", "internal"]),
  tools: new Set(["domain", "core", "runtime", "ports", "adapters", "internal"]),
  adapters: new Set(["domain", "ports", "internal"]),
  internal: new Set(["internal"]),
}

/** Known transitional sync debt — prefer shrinking. */
const SYNC_LAYER_ALLOWLIST = []

const FORBIDDEN_SYNC_TREES = ["application"]

const SYNC_STATE_ALLOWLIST = new Set([
  // process-wide freeze map installed at server boot (see docs/doctrine.md)
  "domain/governance/freeze-windows.ts",
])

function syncLayerOf(relPath) {
  const head = relPath.split("/")[0]
  return SYNC_LAYERS.has(head) ? head : null
}

function isSyncLayerAllowlisted(fromRel, toRel) {
  for (const a of SYNC_LAYER_ALLOWLIST) {
    if (a.from && a.from !== fromRel) continue
    if (a.fromPrefix && !fromRel.startsWith(a.fromPrefix)) continue
    if (a.toPrefix && !toRel.startsWith(a.toPrefix)) continue
    return a
  }
  return null
}

function lintSyncForbiddenTrees() {
  for (const tree of FORBIDDEN_SYNC_TREES) {
    const abs = join(SYNC_SRC, tree)
    if (existsSync(abs)) {
      fail(abs, 0, "sync-forbidden-tree",
        `doctrine forbids packages/sync/src/${tree}/ — use core/ + runtime/ (see docs/doctrine.md)`)
    }
  }
}

function lintSyncTopLevel() {
  if (!existsSync(SYNC_SRC)) return
  const allowedHeads = new Set([
    ...SYNC_LAYERS,
    "test-support",
    "index.ts",
  ])
  for (const name of readdirSync(SYNC_SRC)) {
    if (name.startsWith(".")) continue
    const abs = join(SYNC_SRC, name)
    const st = statSync(abs)
    if (st.isFile()) {
      if (name === "index.ts" || name.endsWith(".md")) continue
      fail(abs, 0, "sync-top-level", `unexpected file at sync src root: ${name}`)
      continue
    }
    if (!allowedHeads.has(name)) {
      fail(abs, 0, "sync-top-level",
        `unknown sync top-level "${name}". Allowed: domain, core, runtime, ports, tools, adapters, internal, test-support`)
    }
  }
}

function lintSyncLayerImports(file, src) {
  const fromRel = relative(SYNC_SRC, file)
  // Co-located tests may reach into sibling layers; production edges are what we enforce.
  if (fromRel.endsWith(".test.ts") || fromRel.endsWith(".test.tsx")) return
  const fromLayer = syncLayerOf(fromRel)
  if (!fromLayer) return

  const lines = src.split("\n")
  const importRe = /(?:import|export)\s+(?:type\s+)?(?:[^"'`;]+?\s+from\s+)?["']([^"']+)["']/g

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue
    importRe.lastIndex = 0
    let m
    while ((m = importRe.exec(line)) !== null) {
      const spec = m[1]
      if (!spec.startsWith(".")) continue
      const targetAbs = resolveImportTarget(file, spec)
      const toRel = relative(SYNC_SRC, targetAbs)
      if (toRel.startsWith("..")) continue
      const toLayer = syncLayerOf(toRel)
      if (!toLayer || toLayer === fromLayer) continue

      const allowed = SYNC_ALLOWED[fromLayer]
      if (allowed?.has(toLayer)) continue

      const debt = isSyncLayerAllowlisted(fromRel, toRel)
      if (debt) continue

      fail(file, i + 1, "sync-layer-import",
        `${fromLayer} may not import ${toLayer} ("${spec}" → ${toRel}). ` +
          `Allowed from ${fromLayer}: ${[...allowed].join(", ") || "(none)"}. ` +
          `See docs/doctrine.md`)
    }
  }
}

function lintSyncModuleState(file, src) {
  const rel = relative(SYNC_SRC, file)
  if (SYNC_STATE_ALLOWLIST.has(rel)) return
  if (rel.startsWith("test-support/")) return
  if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) return

  const lines = src.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.length === 0 || /^\s/.test(line)) continue
    if (line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) continue

    if (/^(export\s+)?let\s+\w/.test(line)) {
      fail(file, i + 1, "sync-no-module-let",
        `top-level "let" — state belongs on SyncHost / runtime (or freeze-window allowlist)`)
    }
    if (/^(export\s+)?var\s+\w/.test(line)) {
      fail(file, i + 1, "sync-no-module-var",
        `top-level "var" declaration at module scope`)
    }
    if (/^export\s+function\s+(get|set|reset)Global[A-Z]/.test(line)) {
      const name = line.match(/(get|set|reset)Global[A-Za-z]+/)?.[0]
      fail(file, i + 1, "sync-no-global-getter-setter",
        `exported "${name}" — thread state via SyncHost`)
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

lintServerForbiddenTrees()
lintServerTopLevel()
const serverFiles = walk(SERVER_SRC)
for (const f of serverFiles) {
  const src = readFileSync(f, "utf8")
  lintServerLayerImports(f, src)
}

lintSyncForbiddenTrees()
lintSyncTopLevel()
const syncFiles = walk(SYNC_SRC)
for (const f of syncFiles) {
  const src = readFileSync(f, "utf8")
  lintSyncLayerImports(f, src)
  lintSyncModuleState(f, src)
}

lintNoDeepPackageImports(SERVER_SRC, "server")
lintNoDeepPackageImports(SYNC_SRC, "sync")
lintNoDeepPackageImports(UI_SRC, "ui")
lintNoDeepPackageImports(AGENT_SRC, "agent")

if (errors.length === 0) {
  console.log(
    `lint-arch: ${agentFiles.length} agent + ${serverFiles.length} server + ${syncFiles.length} sync files OK ` +
      `(${LAYER_ALLOWLIST.length} agent / ${SERVER_LAYER_ALLOWLIST.length} server / ${SYNC_LAYER_ALLOWLIST.length} sync debt allowlists).`,
  )
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
