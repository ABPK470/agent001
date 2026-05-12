/**
 * Coherent solution bundle parsing — JSON parsing, artifact validation, prompt template.
 *
 * Extracted from coherent.ts for maintainability.
 *
 * @module
 */

import { isRecord as _isRecord, asNonEmptyString as _asNonEmptyString } from "../internal/json.js"
import { isValidArtifactPath } from "./generate.js"
import type {
  CoherentSharedContract,
  CoherentSolutionArtifact,
  CoherentSystemInvariant,
  PlanEdge,
} from "./types.js"

// Re-exports preserve the existing public surface of this module.
export const isRecord = _isRecord
export const asNonEmptyString = _asNonEmptyString

export const COHERENT_GENERATION_PROMPT = `You are generating a coherent multi-file implementation bundle.

Goal:
- produce the full architecture in one pass
- keep names, contracts, and file boundaries internally consistent
- return complete file contents for every artifact in the bundle

Rules:
1. Respond ONLY with a JSON object.
2. Prefer a bounded, cohesive solution with a small number of files.
3. Every artifact entry must include path, purpose, and complete file content.
4. File contents must be final code/content, not placeholders or TODOs.
5. Keep shared naming, imports, and state contracts consistent across all artifacts.
6. Do not include markdown fences around file contents.
7. OUTPUT DIRECTORY ISOLATION: Generate all new artifacts inside a single fresh project subdirectory (e.g. \`project/\`, \`app/\`, or a semantically meaningful name like \`client-report/\`). Do NOT place files inside existing source directories such as \`packages/\`, \`src/\`, \`lib/\`, or \`dist/\` unless the goal explicitly targets modifying files that already exist there. A new standalone project must live in its own directory, not mixed into the host repository.

Return JSON of this shape:
{
  "summary": "what the solution is",
  "architecture": "how the files fit together",
  "artifacts": [
    {
      "path": "relative/path.ext",
      "purpose": "what this file owns",
      "content": "full file content"
    }
  ],
  "dependencyEdges": [{ "from": "a", "to": "b" }],
  "sharedContracts": [{ "name": "contract", "description": "exact shared contract" }],
  "invariants": [{ "id": "invariant_id", "description": "system-level invariant" }]
}`

export function parseJsonObject(raw: string): Record<string, unknown> | null {
  // Strategy 1: try direct parse — clean responses with no prose/fencing
  const trimmed = raw.trim()
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (isRecord(parsed)) return parsed
  } catch { /* fall through */ }

  // Strategy 2: extract from a code block, if present.
  // Use a GREEDY match so that file contents that contain their own
  // triple-backtick sequences (e.g. markdown inside a README artifact)
  // don't truncate the capture at the first inner fence.
  let candidate = trimmed
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*)```/)
  if (codeBlockMatch?.[1]) {
    candidate = codeBlockMatch[1].trim()
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (isRecord(parsed)) return parsed
    } catch { /* fall through */ }
  }

  // Strategy 3: balanced-brace extraction — handles responses with
  // prose before/after the JSON, and truncated responses where the LLM
  // hit the output-token ceiling mid-JSON (the most common failure mode).
  // Finds the first '{' and walks characters tracking nesting depth,
  // skipping over string contents so inner braces don't confuse the count.
  const start = candidate.indexOf("{")
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]
    if (escape) { escape = false; continue }
    if (ch === "\\") { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) {
        try {
          const parsed = JSON.parse(candidate.slice(start, i + 1)) as unknown
          if (isRecord(parsed)) return parsed
        } catch { /* truncated or structurally invalid — no recovery */ }
        break
      }
    }
  }

  return null
}

export function parseArtifacts(value: unknown, diagnostics: string[]): CoherentSolutionArtifact[] {
  if (!Array.isArray(value) || value.length === 0) {
    diagnostics.push("Bundle must contain a non-empty artifacts array.")
    return []
  }

  const seenPaths = new Set<string>()
  const artifacts: CoherentSolutionArtifact[] = []

  for (const entry of value) {
    if (!isRecord(entry)) {
      diagnostics.push("Each artifact must be an object with path, purpose, and content.")
      continue
    }
    const path = asNonEmptyString(entry.path)
    const purpose = asNonEmptyString(entry.purpose)
    const content = asNonEmptyString(entry.content)
    if (!path || !purpose || !content) {
      diagnostics.push("Each artifact requires non-empty path, purpose, and content fields.")
      continue
    }
    if (!isValidArtifactPath(path)) {
      diagnostics.push(`Artifact path \"${path}\" is invalid.`)
      continue
    }
    if (seenPaths.has(path)) {
      diagnostics.push(`Artifact path \"${path}\" is duplicated in the coherent bundle.`)
      continue
    }
    seenPaths.add(path)

    // Reject code artifacts that contain TODO placeholders — the coherent bundle
    // must be fully implemented. Stub code causes an unrecoverable repair loop:
    // the write guard blocks the next write for missing functions, while the
    // repair instructions forbid restructuring, trapping the agent in a read spin.
    const isCodeArtifact = /\.(js|ts|jsx|tsx|mjs|cjs|py|java|go|rs|rb|php|cs|cpp|c|h|sh|bash|zsh)$/i.test(path)
    if (isCodeArtifact) {
      const todoLine = content.split("\n").find(l =>
        /\/\/\s*TODO[:\s]|\/\*\s*TODO\b|#\s*TODO[:\s]/.test(l),
      )
      if (todoLine) {
        diagnostics.push(
          `Artifact "${path}" contains TODO placeholders — all coherent bundle artifacts must be fully implemented, not stubs. ` +
          `Found: ${todoLine.trim().slice(0, 120)}`,
        )
        continue
      }
    }

    artifacts.push({ path, purpose, content })
  }

  return artifacts
}

export function parseEdges(value: unknown): PlanEdge[] | undefined {
  if (!Array.isArray(value)) return undefined
  const edges: PlanEdge[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const from = asNonEmptyString(entry.from)
    const to = asNonEmptyString(entry.to)
    if (!from || !to) continue
    edges.push({ from, to })
  }
  return edges.length > 0 ? edges : undefined
}

export function parseSharedContracts(value: unknown): CoherentSharedContract[] | undefined {
  if (!Array.isArray(value)) return undefined
  const contracts: CoherentSharedContract[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const name = asNonEmptyString(entry.name)
    const description = asNonEmptyString(entry.description)
    if (!name || !description) continue
    contracts.push({ name, description })
  }
  return contracts.length > 0 ? contracts : undefined
}

export function parseInvariants(value: unknown): CoherentSystemInvariant[] | undefined {
  if (!Array.isArray(value)) return undefined
  const invariants: CoherentSystemInvariant[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const id = asNonEmptyString(entry.id)
    const description = asNonEmptyString(entry.description)
    if (!id || !description) continue
    invariants.push({ id, description })
  }
  return invariants.length > 0 ? invariants : undefined
}
