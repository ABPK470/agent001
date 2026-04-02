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
 * 3. For reads: realpath() follows symlinks and re-checks the target
 *    (prevents symlink escape: agent writes a symlink pointing to /etc/shadow,
 *     then reads it — realpath reveals the true destination)
 */
function safePath(p: string): string {
  const resolved = resolve(_basePath, p)
  if (!resolved.startsWith(_basePath + "/") && resolved !== _basePath) {
    throw new Error(`Path "${p}" escapes the allowed directory`)
  }
  return resolved
}

/**
 * Like safePath but also follows symlinks to verify the real target.
 * Use for read operations where symlink escape is a risk.
 */
async function safePathResolved(p: string): Promise<string> {
  const resolved = safePath(p) // first check logical path

  // Check if the path itself is a symlink — follow it and verify destination
  try {
    const info = await lstat(resolved)
    if (info.isSymbolicLink()) {
      const real = await realpath(resolved)
      if (!real.startsWith(_basePath + "/") && real !== _basePath) {
        throw new Error(`Symlink "${p}" points outside the allowed directory`)
      }
      return real
    }
  } catch (err) {
    // ENOENT is fine — file doesn't exist yet (write path)
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
  }

  return resolved
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
