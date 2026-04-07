/**
 * search_files — recursive text search across the workspace.
 *
 * Provides grep-like functionality without requiring `run_command`.
 * Supports exact text and regex patterns, optional path filtering,
 * and configurable result limits.
 *
 * Security: Uses the same `_basePath`-scoped path validation as
 * filesystem.ts — all search paths are resolved under the workspace root.
 * Output is capped to prevent memory issues on large codebases.
 */

import { readdir, readFile, stat } from "node:fs/promises"
import { basename, extname, resolve } from "node:path"
import type { Tool } from "../types.js"

// ── Configuration ────────────────────────────────────────────────

/** Max total matches returned (across all files). */
const MAX_MATCHES = 200

/** Max file size to search (skip very large files). */
const MAX_FILE_SIZE = 1_048_576 // 1 MB

/** Context lines above/below each match. */
const CONTEXT_LINES = 2

/** Directories to always skip. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build",
  ".next", ".nuxt", "__pycache__", ".tox", ".venv", "venv",
  "coverage", ".nyc_output", ".cache", ".turbo",
])

/** Binary-ish extensions to skip. */
const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".avif",
  ".mp3", ".mp4", ".wav", ".avi", ".mov", ".mkv", ".flac",
  ".zip", ".gz", ".tar", ".bz2", ".7z", ".rar", ".xz",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".o", ".a",
  ".sqlite", ".db", ".lock",
])

// ── Shared base path (same as filesystem.ts) ────────────────────

let _basePath = process.cwd()

export function setSearchBasePath(path: string): void {
  _basePath = resolve(path)
}

// ── Helpers ──────────────────────────────────────────────────────

interface Match {
  file: string // relative to _basePath
  line: number
  text: string
  context: string[]
}

function shouldSkipFile(name: string): boolean {
  return BINARY_EXTS.has(extname(name).toLowerCase()) || name.startsWith(".")
}

async function* walkFiles(
  dir: string,
  includeGlob: string | undefined,
): AsyncGenerator<string> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const full = resolve(dir, entry.name)

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      yield* walkFiles(full, includeGlob)
    } else if (entry.isFile()) {
      if (shouldSkipFile(entry.name)) continue

      // Simple glob filter: *.ext or exact name match
      if (includeGlob) {
        if (includeGlob.startsWith("*.")) {
          const ext = includeGlob.slice(1) // e.g. ".ts"
          if (extname(entry.name) !== ext) continue
        } else if (basename(full) !== includeGlob) {
          continue
        }
      }

      yield full
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// ── Tool ─────────────────────────────────────────────────────────

export const searchFilesTool: Tool = {
  name: "search_files",
  description:
    "Search for text or a regex pattern across files in the workspace. " +
    "Returns matching lines with file paths and line numbers. " +
    "Useful for finding function definitions, references, TODOs, etc.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Text or regex pattern to search for",
      },
      path: {
        type: "string",
        description: "Directory to search in (default: workspace root). Relative to working directory.",
      },
      include: {
        type: "string",
        description: "File filter — e.g. '*.ts' or 'package.json'. Only files matching this are searched.",
      },
      regex: {
        type: "boolean",
        description: "If true, treat pattern as a regex. Default: false (exact text match).",
      },
    },
    required: ["pattern"],
  },

  async execute(args) {
    try {
      const pattern = String(args.pattern)
      if (!pattern) return "Error: pattern is required"

      const isRegex = Boolean(args.regex)
      const include = args.include ? String(args.include) : undefined
      const searchDir = args.path ? resolve(_basePath, String(args.path)) : _basePath

      // Validate search dir is within workspace
      if (!searchDir.startsWith(_basePath + "/") && searchDir !== _basePath) {
        return `Error: search path escapes the workspace`
      }

      // Compile regex (or escape literal)
      let re: RegExp
      try {
        re = isRegex ? new RegExp(pattern, "gi") : new RegExp(escapeRegex(pattern), "gi")
      } catch (err) {
        return `Error: invalid regex — ${err instanceof Error ? err.message : String(err)}`
      }

      const matches: Match[] = []
      let filesSearched = 0
      let truncated = false

      for await (const filePath of walkFiles(searchDir, include)) {
        if (matches.length >= MAX_MATCHES) {
          truncated = true
          break
        }

        // Skip large files
        try {
          const info = await stat(filePath)
          if (info.size > MAX_FILE_SIZE) continue
        } catch {
          continue
        }

        let content: string
        try {
          content = await readFile(filePath, "utf-8")
        } catch {
          continue
        }

        filesSearched++
        const lines = content.split("\n")
        const rel = filePath.slice(_basePath.length + 1)

        for (let i = 0; i < lines.length; i++) {
          // Re-create regex to reset lastIndex for each line
          if (re.test(lines[i])) {
            const ctxStart = Math.max(0, i - CONTEXT_LINES)
            const ctxEnd = Math.min(lines.length - 1, i + CONTEXT_LINES)
            const context: string[] = []
            for (let c = ctxStart; c <= ctxEnd; c++) {
              context.push(`${c === i ? ">" : " "} ${c + 1}: ${lines[c]}`)
            }
            matches.push({ file: rel, line: i + 1, text: lines[i], context })

            if (matches.length >= MAX_MATCHES) {
              truncated = true
              break
            }
          }
          // Reset regex state
          re.lastIndex = 0
        }
      }

      if (matches.length === 0) {
        return `No matches found for "${pattern}" (searched ${filesSearched} files)`
      }

      // Format output
      const parts: string[] = []
      parts.push(`Found ${matches.length} match${matches.length > 1 ? "es" : ""} in ${filesSearched} files${truncated ? " (results truncated)" : ""}:\n`)

      // Group by file for readability
      const byFile = new Map<string, Match[]>()
      for (const m of matches) {
        const existing = byFile.get(m.file)
        if (existing) existing.push(m)
        else byFile.set(m.file, [m])
      }

      for (const [file, fileMatches] of byFile) {
        parts.push(`── ${file} ──`)
        for (const m of fileMatches) {
          parts.push(m.context.join("\n"))
          parts.push("")
        }
      }

      return parts.join("\n")
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }
  },
}
