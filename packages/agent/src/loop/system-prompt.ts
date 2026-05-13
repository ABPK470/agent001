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

import { readFileSync } from "node:fs"

function loadPrompt(name: string): string {
  // Try source-tree path first (depth-2 escape from src/loop/), then bundled path.
  const candidates = [
    new URL(`../../prompts/${name}`, import.meta.url),
    new URL(`./prompts/${name}`,    import.meta.url),
  ]
  let lastErr: unknown
  for (const url of candidates) {
    try { return readFileSync(url, "utf8") } catch (err) { lastErr = err }
  }
  throw new Error(`prompt asset not found: ${name} (tried ${candidates.map(u => u.pathname).join(", ")}) — last error: ${String(lastErr)}`)
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
