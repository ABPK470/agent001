/**
 * Filesystem tools — let the agent read, write, and list files.
 *
 * These are the same kind of tools that GitHub Copilot, Cursor,
 * and other coding agents use to interact with your codebase.
 *
 * Security — 4-layer path validation (matching agenc-core):
 *   Layer 1: Input validation — reject null bytes, URL-encoded separators
 *   Layer 2: Traversal detection — reject ".." BEFORE path resolution
 *   Layer 3: Symlink resolution — walk every component with realpath()
 *   Layer 4: Allowed root check — canonical path must be under _basePath
 *
 * Delete protection:
 *   No delete tool is exposed. Shell blocklist prevents rm on sensitive paths.
 *   write_file only creates/overwrites — no unlink/rmdir.
 */

import { lstat, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"
import type { Tool } from "../types.js"

/** Restrict all file operations to a base directory (safety). */
let _basePath = process.cwd()

export function setBasePath(path: string): void {
  _basePath = resolve(path)
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
 */
function safePath(p: string): string {
  validateInput(p)
  rejectTraversal(p)
  const resolved = resolve(_basePath, p)
  if (!resolved.startsWith(_basePath + "/") && resolved !== _basePath) {
    throw new Error(`Path "${p}" escapes the allowed directory`)
  }
  return resolved
}

/**
 * Full 4-layer validation: input → traversal → symlink walk → root check.
 *
 * Walks EVERY path component from _basePath downward:
 *   /workspace/a/b/c.txt → check /workspace/a, then /workspace/a/b
 *
 * If any component is a symlink, follow it with realpath() and verify
 * the real target stays inside _basePath.
 */
async function safePathResolved(p: string): Promise<string> {
  const resolved = safePath(p) // Layers 1, 2, 4 (logical check)

  // Layer 3: walk each component for symlinks
  const suffix = resolved.slice(_basePath.length + 1)
  if (!suffix) return resolved // path IS _basePath

  const segments = suffix.split("/")
  let current = _basePath

  for (const segment of segments) {
    current = resolve(current, segment)

    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) {
        const real = await realpath(current)
        // Layer 4 re-check on the real path
        if (!real.startsWith(_basePath + "/") && real !== _basePath) {
          throw new Error(`Symlink at "${current.slice(_basePath.length + 1)}" points outside the allowed directory`)
        }
        // Continue walking from the resolved real path
        current = real
      }
    } catch (err) {
      // ENOENT: path doesn't exist yet (for writes) — stop walking
      if ((err as NodeJS.ErrnoException).code === "ENOENT") break
      // Re-throw our own symlink/validation errors
      if (err instanceof Error && err.message.includes("outside the allowed directory")) throw err
      // Other errors (EACCES etc.) — propagate
      if ((err as NodeJS.ErrnoException).code) throw err
    }
  }

  return current
}

// ── read_file ────────────────────────────────────────────────────

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "Read the contents of a file. Returns the full text content. " +
    "Paths are relative to the working directory.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to read" },
    },
    required: ["path"],
  },

  async execute(args) {
    try {
      const content = await readFile(await safePathResolved(String(args.path)), "utf-8")
      return content
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }
  },
}

// ── write_file ───────────────────────────────────────────────────

export const writeFileTool: Tool = {
  name: "write_file",
  description:
    "Write content to a file. Creates the file if it doesn't exist, " +
    "overwrites if it does. Paths are relative to the working directory.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to write to" },
      content: { type: "string", description: "Content to write" },
    },
    required: ["path", "content"],
  },

  async execute(args) {
    try {
      // Use safePathResolved to prevent writing through symlinks that point outside workspace
      const target = await safePathResolved(String(args.path))
      await writeFile(target, String(args.content), "utf-8")
      return `Successfully wrote to ${args.path}`
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }
  },
}

// ── list_directory ───────────────────────────────────────────────

export const listDirectoryTool: Tool = {
  name: "list_directory",
  description:
    "List the contents of a directory. Returns file and folder names. " +
    "Folders end with /. Paths are relative to the working directory.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory path (default: current directory)",
      },
    },
  },

  async execute(args) {
    try {
      const dir = await safePathResolved(String(args.path ?? "."))
      const entries = await readdir(dir)
      const lines: string[] = []

      for (const entry of entries) {
        try {
          const info = await stat(resolve(dir, entry))
          lines.push(info.isDirectory() ? `${entry}/` : entry)
        } catch {
          lines.push(entry)
        }
      }

      return lines.join("\n") || "(empty directory)"
    } catch (err) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        // Path doesn't exist — help the agent by listing what's actually in the parent
        const requestedPath = String(args.path ?? ".")
        const parentDir = dirname(safePath(requestedPath))
        try {
          const parentEntries = await readdir(parentDir)
          const items = parentEntries.slice(0, 30).join(", ")
          const rel = parentDir.replace(_basePath, ".") || "."
          return `Error: "${requestedPath}" does not exist. Contents of ${rel}: ${items}`
        } catch {
          return `Error: "${requestedPath}" does not exist.`
        }
      }
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }
  },
}
