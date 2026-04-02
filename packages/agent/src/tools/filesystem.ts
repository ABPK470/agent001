/**
 * Filesystem tools — let the agent read, write, and list files.
 *
 * These are the same kind of tools that GitHub Copilot, Cursor,
 * and other coding agents use to interact with your codebase.
 *
 * Security:
 *   - All paths resolved relative to a base directory
 *   - Symlinks are followed and the REAL path is checked against the base
 *     (prevents symlink-escape attacks like: agent creates symlink → reads /etc/shadow)
 *   - Path traversal ("../") is blocked by resolve + startsWith check
 */

import { lstat, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { Tool } from "../types.js"

/** Restrict all file operations to a base directory (safety). */
let _basePath = process.cwd()

export function setBasePath(path: string): void {
  _basePath = resolve(path)
}

/**
 * Resolve a path safely within the base directory.
 *
 * 1. resolve() normalizes ".." and relative segments
 * 2. startsWith() ensures the result is under _basePath
 */
function safePath(p: string): string {
  const resolved = resolve(_basePath, p)
  if (!resolved.startsWith(_basePath + "/") && resolved !== _basePath) {
    throw new Error(`Path "${p}" escapes the allowed directory`)
  }
  return resolved
}

/**
 * Like safePath but also walks EVERY path component to detect symlinks.
 *
 * Checks each intermediate directory from _basePath downward:
 *   /workspace/a/b/c.txt → check /workspace/a, then /workspace/a/b
 *
 * If any component is a symlink, follow it with realpath() and verify
 * the real target stays inside _basePath. This prevents:
 *   - Agent creates symlink /workspace/evil → /etc
 *   - Agent reads /workspace/evil/shadow
 *   - resolve() gives /workspace/evil/shadow (looks safe)
 *   - But evil/ is a symlink to /etc/ so real path is /etc/shadow
 *
 * By checking each component we catch this at the "evil" directory level.
 */
async function safePathResolved(p: string): Promise<string> {
  const resolved = safePath(p) // first check logical path

  // Walk each component from _basePath downward
  // e.g. for /workspace/a/b/c.txt → segments = ["a", "b", "c.txt"]
  const suffix = resolved.slice(_basePath.length + 1) // "a/b/c.txt"
  if (!suffix) return resolved // path IS _basePath

  const segments = suffix.split("/")
  let current = _basePath

  for (const segment of segments) {
    current = resolve(current, segment)

    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) {
        const real = await realpath(current)
        if (!real.startsWith(_basePath + "/") && real !== _basePath) {
          throw new Error(`Symlink at "${current.slice(_basePath.length + 1)}" points outside the allowed directory`)
        }
        // Continue walking from the resolved real path
        current = real
      }
    } catch (err) {
      // ENOENT: path doesn't exist yet (for writes) — fine, stop walking
      if ((err as NodeJS.ErrnoException).code === "ENOENT") break
      // Re-throw our own symlink errors and real I/O errors
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
