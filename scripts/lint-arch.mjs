#!/usr/bin/env node
/**
 * lint-arch.mjs — architecture lint for `packages/agent/src/`, `packages/server/src/`, and `packages/sync/src/`.
 *
 * Enforces, with no external dependencies. All violations are ERRORs.
 *
 * ERRORS:
 *   1. CLUSTER DOORS
 *      Files outside cluster `<X>/` may not import deep into `<X>/`. Only
 *      `<X>/index.js` is importable from the outside.
 *
 *   2. NO MODULE-LEVEL MUTABLE STATE outside designated runtime files
 *      Bans top-level `let` / `var`. Bans top-level `setInterval` /
 *      `setTimeout`. Bans exported `getGlobal*` / `setGlobal*` symbols.
 *      Allow-listed files keep working.
 *
 *   3. SERVER MAY NOT REACH INTO AGENT INTERNALS
 *      `packages/server/**` may only import `@mia/agent`, never
 *      `packages/agent/src/**`.
 *
 *   4. SERVER MUST IMPORT EXTRACTED SYNC APIS FROM `@mia/sync`
 *      Once Phase 7 lands, server sync entrypoints may not come from
 *      `@mia/agent` anymore.
 *
 * ERRORS (doctrine — see docs/doctrine.md):
 *   5. NO NEW AsyncLocalStorage instances. Known cases are allow-listed.
 *      Every new `new AsyncLocalStorage(...)` fails until the file is
 *      added to the allow-list.
 *
 *   6. NO NEW exported `set<Pascal>(...)` mutator functions. Existing
 *      ones are allow-listed; the list shrinks as Phase 4 migrates clusters.
 *
 *   7. NO BANNED type-name suffixes (Provider / Service / Resolver /
 *      Executor / Sandbox / Repository / Manager / Handler / Helper).
 *      Use the four canonical suffixes instead (Sink / Store / Reader /
 *      Client) — see docs/doctrine.md §4. Existing names allow-listed.
 *
 * Run with: `node scripts/lint-arch.mjs`
 * Exits non-zero on any ERROR.
 * Designed to slot into CI and pre-commit.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(fileURLToPath(import.meta.url), "../..")
const AGENT_SRC = join(ROOT, "packages/agent/src")
const SERVER_SRC = join(ROOT, "packages/server/src")
const SYNC_SRC = join(ROOT, "packages/sync/src")

// Clusters that own a public `index.ts` door.
const CLUSTERS = new Set([
  "context", "recovery", "delegation", "governance", "tool-helpers",
  "loop", "llm", "tools", "sync", "internal", "engine", "planner",
  "host",
])

const CLUSTER_DOOR_ALLOWLIST = new Set([
  "packages/agent/src/application/core/planner-cluster/orchestrator/orchestrate.ts|../../../../planner/verifier/index.js",
  "packages/agent/src/application/core/planner-cluster/orchestrator/setup-delegation.ts|../../../../delegation/decision/index.js",
])

// Files that are allowed to hold module-level state. The only legitimate
// owner is `agent-runtime.ts`. Every other file's state must live inside a
// `const _state = { ... }` record so this lint stays clean.
const STATE_ALLOWLIST = new Set([
  "agent-runtime.ts",
])

// File-level allow-list overrides for setInterval / setTimeout at module load.
// Empty as of cluster 7 — `tools/browse-web/session.ts` no longer auto-starts
// its cleanup timer at module load (the timer now lives on
// `AgentHost.browser.cleanupTimer` and is started lazily by `launchSession`).
const TIMER_ALLOWLIST = new Set([
])

// ── Doctrine allowlists ────────────────────────────────────────────
//
// These lists capture every existing violation as of the start of the
// Functional Core / Imperative Shell refactor (docs/doctrine.md).
// As Phase 4–5 migrates clusters, entries are removed from these lists.
// Paths are workspace-relative.

const ALS_ALLOWLIST = new Set([
  "packages/agent/src/application/shell/loop-cluster/tool-execution/trace-context.ts",
  "packages/agent/src/domain/policy-context.ts",
  "packages/sync/src/sync-events.ts",
  "packages/agent/src/agent-runtime.ts",
  "packages/agent/src/tools/mssql/connection.ts",
  "packages/server/src/auth/context.ts",
])

// Files containing exported `set<Pascal>(...)` mutators. Each entry will
// be deleted in Phase 4 as its cluster migrates to closure-bound tools.
const SETTER_ALLOWLIST = new Set([
  "packages/sync/src/sync-events.ts",
  "packages/sync/src/sync-run-sink.ts",
  "packages/sync/src/environments.ts",
  "packages/sync/src/orchestrator/contract-deploy.ts",
  "packages/agent/src/application/shell/tenant-config.ts",
  "packages/agent/src/tools/search-files.ts",
  "packages/agent/src/tools/fetch-url/index.ts",
  "packages/agent/src/tools/browser-check/index.ts",
  "packages/agent/src/tools/browse-web/session.ts",
  "packages/agent/src/tools/ask-user.ts",
  "packages/agent/src/tools/attachments.ts",
  "packages/agent/src/tools/shell/index.ts",
  "packages/agent/src/tools/filesystem-security.ts",
  "packages/agent/src/tools/mssql/connection.ts",
  // The setters below mutate persistent records, not ambient state.
  // They're allow-listed permanently (legitimate "update this row").
  "packages/server/src/db/users.ts",
  "packages/server/src/browser/proxy.ts",
  "packages/server/src/attachments/repo.ts",
  "packages/server/src/setup-mssql.ts",
  "packages/ui-term/src/uiPref.ts",
])

const SETTER_NAME_ALLOWLIST = new Set([
  "setContractLockDirect",
])

// Banned type-name suffixes (see docs/doctrine.md §4). Each entry below
// is an existing type name that violates the rule. Renamed during Phase 4–5
// per the rename map in /memories/session/plan.md.
const BANNED_SUFFIX_ALLOWLIST = new Set([
  // Will be renamed:
  "AuditService",                        // → AuditStore
  "MemoryRunRepository",                 // → RunStore (in-memory)
  "MemoryAuditRepository",               // → AuditStore (in-memory)
  "MemoryExecutionRecordRepository",     // → ExecutionRecordStore (in-memory)
  "RunRepository",                       // → RunStore
  "AuditRepository",                     // → AuditStore
  "ExecutionRecordRepository",           // → ExecutionRecordStore
  "BrowserContextProvider",              // → BrowserContextReader
  "BrowserCredentialProvider",           // → CredentialReader
  "BrowserHandoffProvider",              // → HandoffStore
  "AttachmentService",                   // → AttachmentStore
  "AskUserResolver",                     // → UserInputReader
  "ShellExecutor",                       // → ShellClient
  "BrowserCheckExecutor",                // → BrowserClient
  "RecipeResolver",                      // → RecipeReader
  "ToolKillManager",                     // TBD — kept for now
  "NoteHandler",                         // domain callback type — kept
  "KeybindHandler",                      // UI event callback — kept
  "RecordTableVerdictHandler",           // domain callback type — kept
  "RecallPriorResultHandler",            // domain callback type — kept
  // Permanently kept (genuine domain concepts):
  "DockerSandbox",                       // domain noun, not a port suffix
  "LlmProvider",                         // enum of provider names, not a port
])

const errors = []
const warnings = []
function fail(file, line, rule, detail) {
  errors.push({ file, line, rule, detail })
}
function warn(file, line, rule, detail) {
  warnings.push({ file, line, rule, detail })
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
      const relFromRoot = relative(ROOT, file)
      if (CLUSTER_DOOR_ALLOWLIST.has(`${relFromRoot}|${spec}`)) continue
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

const PHASE7_SYNC_SYMBOLS = new Set([
  "configurePlanStore",
  "configureSyncOrchestrator",
  "createCompareCatalogsTool",
  "createListEnvironmentsTool",
  "createSyncExecuteTool",
  "createSyncPreviewTool",
  "executeSync",
  "getEnvironments",
  "loadPlan",
  "loadSyncRecipes",
  "previewSync",
  "searchEntities",
  "replaceEnvironments",
  "configureSyncEventSink",
  "configureSyncRunSink",
  "setEnvironments",
  "setSyncEventSink",
  "setSyncRunSink",
  "withPermissionDefaults",
])

function lintServerSyncPackageBoundary() {
  if (!safeStat(SERVER_SRC)) return
  for (const file of walk(SERVER_SRC)) {
    const src = readFileSync(file, "utf8")
    const importRe = /import\s*\{([\s\S]*?)\}\s*from\s*["']@mia\/agent["']/g
    let match
    while ((match = importRe.exec(src)) !== null) {
      const names = match[1]
        .split(",")
        .map((s) => s.replace(/\btype\b/g, "").trim())
        .filter(Boolean)
        .map((s) => s.split(/\s+as\s+/i)[0]?.trim() ?? s)
      const bad = names.filter((name) => PHASE7_SYNC_SYMBOLS.has(name))
      if (bad.length === 0) continue
      const line = src.slice(0, match.index).split("\n").length
      fail(file, line, "server-sync-package-boundary",
        `import extracted sync API(s) from "@mia/sync", not "@mia/agent": ${bad.join(", ")}`)
    }
  }
}
// ── Rule 4: no new AsyncLocalStorage instances ────────────────────
function lintNoAls(file, src) {
  const relFromRoot = relative(ROOT, file)
  if (ALS_ALLOWLIST.has(relFromRoot)) return
  const lines = src.split("\n")
  for (let i = 0; i < lines.length; i++) {
    if (/\bnew\s+AsyncLocalStorage\b/.test(lines[i])) {
      fail(file, i + 1, "no-als-doctrine",
        `new AsyncLocalStorage forbidden by docs/doctrine.md §6 — thread deps as parameters`)
    }
  }
}

// ── Rule 5: no new exported set<Pascal> mutator functions ─────────
function lintNoSetters(file, src) {
  const relFromRoot = relative(ROOT, file)
  if (SETTER_ALLOWLIST.has(relFromRoot)) return
  const lines = src.split("\n")
  for (let i = 0; i < lines.length; i++) {
    // export function set<Pascal>(...) — catches top-level exported setters.
    const m = lines[i].match(/^export\s+(?:async\s+)?function\s+(set[A-Z][A-Za-z0-9_]*)\s*\(/)
    if (m) {
      if (SETTER_NAME_ALLOWLIST.has(m[1])) continue
      fail(file, i + 1, "no-setter-doctrine",
        `exported "${m[1]}" forbidden by docs/doctrine.md §6 — build state at boot via configureAgent`)
    }
  }
}

// ── Rule 6: no banned type-name suffixes ─────────────────────────
const BANNED_SUFFIX_RE =
  /^export\s+(?:abstract\s+)?(?:interface|class|type)\s+([A-Z][A-Za-z0-9_]*?(Provider|Service|Resolver|Executor|Sandbox|Repository|Manager|Handler|Helper))\b/
function lintBannedSuffixes(file, src) {
  const lines = src.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(BANNED_SUFFIX_RE)
    if (!m) continue
    const typeName = m[1]
    if (BANNED_SUFFIX_ALLOWLIST.has(typeName)) continue
    fail(file, i + 1, "banned-suffix-doctrine",
      `type name "${typeName}" uses banned suffix — use *Sink / *Store / *Reader / *Client (docs/doctrine.md §4)`)
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
  lintNoAls(f, src)
  lintNoSetters(f, src)
  lintBannedSuffixes(f, src)
}
lintServerImports()
lintServerSyncPackageBoundary()

// Apply doctrine rules outside the agent package too.
const extraRoots = [SERVER_SRC, SYNC_SRC, join(ROOT, "packages/ui-term/src")]
let extraFileCount = 0
for (const root of extraRoots) {
  if (!safeStat(root)) continue
  for (const f of walk(root)) {
    extraFileCount += 1
    const src = readFileSync(f, "utf8")
    lintNoAls(f, src)
    lintNoSetters(f, src)
    lintBannedSuffixes(f, src)
  }
}

if (errors.length === 0) {
  console.log(`lint-arch: ${agentFiles.length + extraFileCount} files OK.`)
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
