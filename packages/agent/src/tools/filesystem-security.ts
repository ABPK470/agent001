import { ToolControlDirective, ToolOutcomeSeverity } from "../domain/index.js"
/**
 * Filesystem path validation and security helpers.
 *
 * 4-layer path validation (matching agenc-core):
 *   Layer 1: Input validation — reject null bytes, URL-encoded separators
 *   Layer 2: Traversal detection — reject ".." BEFORE path resolution
 *   Layer 3: Symlink resolution — walk every component with realpath()
 *   Layer 4: Allowed root check — canonical path must be under `host.filesystem.basePath`
 *
 * All helpers take an {@link AgentHost} explicitly. No ambient state.
 *
 * @module
 */

import { lstat, realpath } from "node:fs/promises"
import { resolve, sep } from "node:path"
import type { AgentHost } from "../application/shell/runtime.js"
import type { ToolResultEnvelope } from "../domain/agent-types.js"

export function buildToolOutcome(
  summary: string,
  overrides: Omit<ToolResultEnvelope, "summary"> = { ok: true }
): ToolResultEnvelope {
  return {
    ...overrides,
    ok: overrides.ok ?? true,
    severity:
      overrides.severity ??
      (overrides.ok === false ? ToolOutcomeSeverity.Recoverable : ToolOutcomeSeverity.Info),
    directive: overrides.directive ?? ToolControlDirective.Continue,
    retryable: overrides.retryable ?? true,
    summary
  }
}

// ── Layer 1: Input validation ────────────────────────────────────

/**
 * Reject paths containing dangerous byte sequences BEFORE any resolution.
 * Catches:
 *   - Null bytes (\0) — can truncate paths at the C level
 *   - URL-encoded separators (%2f, %5c) — can bypass string checks
 *   - URL-encoded null (%00) — same null byte trick via encoding
 *   - Backslash on non-Windows — can be misinterpreted
 */
function validateInput(p: string): void {
  if (p.includes("\0") || p.includes("%00")) {
    throw new Error("Path contains null byte — rejected")
  }
  if (/%2f/i.test(p) || /%5c/i.test(p)) {
    throw new Error("Path contains encoded separator — rejected")
  }
  // On POSIX, reject backslashes (common in cross-platform attacks)
  if (sep === "/" && p.includes("\\")) {
    throw new Error("Path contains backslash — rejected on POSIX")
  }
}

// ── Layer 2: Traversal detection ─────────────────────────────────

/**
 * Reject explicit ".." segments BEFORE path.resolve() processes them.
 * Defense-in-depth: resolve() handles ".." correctly in Node, but
 * rejecting early prevents any edge-case where a different layer
 * might interpret the path differently.
 */
function rejectTraversal(p: string): void {
  const segments = p.split(/[/\\]/)
  if (segments.includes("..")) {
    throw new Error(`Path "${p}" contains ".." traversal — rejected`)
  }
}

// ── Layers 3+4: Symlink resolution + root check ─────────────────

/**
 * Resolve a path safely within the base directory (Layer 4 only).
 * Used as a fast synchronous check when symlink resolution isn't needed.
 * Takes the host explicitly.
 */
export function safePathWith(host: AgentHost, p: string): string {
  const basePath = host.filesystem.basePath
  validateInput(p)
  rejectTraversal(p)
  const resolved = resolve(basePath, p)
  if (!resolved.startsWith(basePath + "/") && resolved !== basePath) {
    throw new Error(`Path "${p}" escapes the allowed directory`)
  }
  return resolved
}

/**
 * Full 4-layer validation: input → traversal → symlink walk → root check.
 * Takes the host explicitly.
 */
export async function safePathResolvedWith(host: AgentHost, p: string): Promise<string> {
  const basePath = host.filesystem.basePath
  const resolved = safePathWith(host, p) // Layers 1, 2, 4 (logical check)

  // Layer 3: walk each component for symlinks
  const suffix = resolved.slice(basePath.length + 1)
  if (!suffix) return resolved // path IS basePath

  const segments = suffix.split("/")
  let current = basePath

  for (const segment of segments) {
    current = resolve(current, segment)

    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) {
        const real = await realpath(current)
        // Layer 4 re-check on the real path
        if (!real.startsWith(basePath + "/") && real !== basePath) {
          throw new Error(
            `Symlink at "${current.slice(basePath.length + 1)}" points outside the allowed directory`
          )
        }
        // Continue walking from the resolved real path
        current = real
      }
    } catch (err) {
      // ENOENT: path doesn't exist yet (for writes)
      // ENOTDIR: a parent component is a file, not a directory
      //   (write_file will handle replacing it with a directory)
      // In both cases, stop symlink checking but append ALL remaining
      // segments so we return the complete target path.
      if (
        (err as NodeJS.ErrnoException).code === "ENOENT" ||
        (err as NodeJS.ErrnoException).code === "ENOTDIR"
      ) {
        // current already includes this segment; append the rest
        const remaining = segments.slice(segments.indexOf(segment) + 1)
        for (const rest of remaining) {
          current = resolve(current, rest)
        }
        break
      }
      // Re-throw our own symlink/validation errors
      if (err instanceof Error && err.message.includes("outside the allowed directory")) throw err
      // Other errors (EACCES etc.) — propagate
      if ((err as NodeJS.ErrnoException).code) throw err
    }
  }

  return current
}
