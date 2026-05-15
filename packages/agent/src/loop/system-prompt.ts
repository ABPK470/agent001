/**
 * Default system prompts for the agent — loaded from packages/agent/prompts/*.md.
 *
 * Why .md files (not TS string literals)?
 *   1. Editable without touching code; markdown editors get syntax highlighting.
 *   2. Diff-friendly — a prompt change is a content diff, not a TS edit.
 *   3. Lint-able — see tests/prompt-source-lint.test.ts for byte ceilings
 *      and anti-duplication assertions.
 *
 * Load strategy: dual-path readFileSync at module init.
 *   - Source / vitest:  import.meta.url is .../packages/agent/src/loop/system-prompt.ts
 *                       → ../../prompts/X.md → packages/agent/prompts/X.md
 *   - Bundled (esbuild → dist/server.js): import.meta.url is .../dist/server.js
 *                       → ./prompts/X.md → dist/prompts/X.md (copied by scripts/build.mjs)
 *
 * @module
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Resolve candidate paths for a prompt asset, in priority order.
 *
 * Why three candidates?
 *   1. Live source under cwd: when the bundled `dist/server.js` is launched
 *      from the repo root (the typical dev loop), edits to
 *      packages/agent/prompts/X.md should be picked up on restart WITHOUT
 *      rebundling. Without this candidate, the bundled fallback (#3) wins
 *      and silently serves a stale copy from `dist/prompts/`.
 *   2. Source tree relative to this file: works when running TypeScript
 *      directly via tsx / vitest.
 *   3. Bundled assets next to dist/server.js: production deployments where
 *      the source tree is absent.
 *
 * The first candidate that exists wins. The chosen path + content hash is
 * logged once at module init so prompt-staleness bugs are self-diagnosing.
 */
function resolvePromptCandidates(name: string): string[] {
  const out: string[] = []

  // 1. Live source under process.cwd() — wins for dev when the user is in
  //    the repo root, even when they're running `node dist/server.js`.
  const cwdSource = resolve(process.cwd(), "packages/agent/prompts", name)
  out.push(cwdSource)

  // 2. Source tree relative to this module (depth-2 escape from src/loop/).
  out.push(fileURLToPath(new URL(`../../prompts/${name}`, import.meta.url)))

  // 3. Bundled path next to dist/server.js (production).
  out.push(fileURLToPath(new URL(`./prompts/${name}`, import.meta.url)))

  return out
}

function loadPrompt(name: string): string {
  const candidates = resolvePromptCandidates(name)
  let chosenPath: string | null = null
  let body: string | null = null
  let lastErr: unknown
  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      body = readFileSync(p, "utf8")
      chosenPath = p
      break
    } catch (err) { lastErr = err }
  }
  if (body === null || chosenPath === null) {
    throw new Error(`prompt asset not found: ${name} (tried ${candidates.join(", ")}) — last error: ${String(lastErr)}`)
  }

  // Boot log: makes it trivial to see which file actually loaded — answers
  // "why is the agent still serving the old prompt?" by inspection.
  const sha = createHash("sha1").update(body).digest("hex").slice(0, 8)
  // eslint-disable-next-line no-console
  console.log(`[prompt] ${name} ← ${chosenPath} sha=${sha} bytes=${body.length}`)

  // Drift warning: if a different candidate also exists with a different hash,
  // surface it once so the operator knows there's a stale shadow file.
  for (const p of candidates) {
    if (p === chosenPath) continue
    if (!existsSync(p)) continue
    try {
      const otherSha = createHash("sha1").update(readFileSync(p, "utf8")).digest("hex").slice(0, 8)
      if (otherSha !== sha) {
        // eslint-disable-next-line no-console
        console.warn(`[prompt] drift: ${name} also exists at ${p} (sha=${otherSha}) — using ${chosenPath} (sha=${sha})`)
      }
    } catch { /* ignore */ }
  }

  return body
}

/**
 * Default agent system prompt — used as:
 *   1. Fallback in Agent constructor (direct / test usage)
 *   2. Anchor when no agentId is passed to the orchestrator (raw runs)
 *   3. Seeded into the "Universal Agent" DB record at startup
 */
export const DEFAULT_SYSTEM_PROMPT = loadPrompt("default-system.md")

/**
 * Chart-kind catalogue. Injected into the system prompt only when the
 * goal looks visual (see `decideSections` in the server) and exposed
 * on demand to all goals via the `get_chart_specs` tool. Saves ~3K
 * tokens on every non-visual call.
 */
export const CHART_CATALOGUE_SECTION = loadPrompt("chart-catalogue.md")

/**
 * Full ABI Environment Sync SME block. Injected only when the user
 * goal involves sync/database/mymi operations. Kept separate from
 * DEFAULT_SYSTEM_PROMPT to avoid wasting token budget on non-sync tasks.
 */
export const ABI_SYNC_SECTION = loadPrompt("abi-sync.md")

/**
 * Big-table / micro-ETL discipline (canonical #temp staging pattern,
 * anti-patterns, allowed mutation list). Injected ONLY when the goal is
 * data/SQL/warehouse-shaped (`includeMssqlGuidance`). The default system
 * prompt keeps a one-line reality hint pointing at this section so casual
 * "hi" / non-DB requests don't pay its ~2 KB cost.
 */
export const BIG_TABLE_ETL_SECTION = loadPrompt("big-table-etl.md")
