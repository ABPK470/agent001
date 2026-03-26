/**
 * Filesystem tools — let the agent read, write, and list files.
 *
 * These are the same kind of tools that GitHub Copilot, Cursor,
 * and other coding agents use to interact with your codebase.
 */

import { readdir, readFile, stat, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { Tool } from "../types.js"

/** Restrict all file operations to a base directory (safety). */
let _basePath = process.cwd()

export function setBasePath(path: string): void {
  _basePath = resolve(path)
}

function safePath(p: string): string {
  const resolved = resolve(_basePath, p)
  if (!resolved.startsWith(_basePath)) {
    throw new Error(`Path "${p}" escapes the allowed directory`)
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
      const content = await readFile(safePath(String(args.path)), "utf-8")
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
      await writeFile(safePath(String(args.path)), String(args.content), "utf-8")
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
      const dir = safePath(String(args.path ?? "."))
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
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }
  },
}
