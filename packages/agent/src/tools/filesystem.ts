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

import { appendFile, lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"
import { detectPlaceholderPatterns } from "../code-quality.js"
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
      // ENOENT: path doesn't exist yet (for writes)
      // ENOTDIR: a parent component is a file, not a directory
      //   (write_file will handle replacing it with a directory)
      // In both cases, stop symlink checking but append ALL remaining
      // segments so we return the complete target path.
      if ((err as NodeJS.ErrnoException).code === "ENOENT" ||
          (err as NodeJS.ErrnoException).code === "ENOTDIR") {
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
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ENOTDIR") {
        return `Error: A parent directory in the path "${String(args.path)}" is a regular file, not a directory. Use write_file to the intended path first (it will fix the directory structure), then retry the read.`
      }
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }
  },
}

// ── write_file ───────────────────────────────────────────────────

export const writeFileTool: Tool = {
  name: "write_file",
  description:
    "Write content to a file. Creates the file if it doesn't exist. " +
    "WARNING: This REPLACES the entire file content — it does NOT append. " +
    "To add code to an existing file, you MUST include all existing content plus your additions. " +
    "Paths are relative to the working directory.",
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

      // ── Regression guard: snapshot existing file before overwrite ──
      // If the file already exists, extract its defined names so we can detect
      // function/class loss after writing. This catches destructive rewrites
      // where the child drops existing functions that other code depends on.
      let priorNames: Set<string> | undefined
      try {
        const existing = await readFile(target, "utf-8")
        if (existing.length > 0) {
          priorNames = extractDefinedNames(existing)
        }
      } catch { /* file doesn't exist yet — no regression possible */ }

      // Auto-create parent directories (safe: target is already validated under _basePath)
      const parentDir = dirname(target)
      try {
        await mkdir(parentDir, { recursive: true })
      } catch (mkdirErr) {
        // ENOTDIR: a parent component exists as a regular file, not a directory.
        // EEXIST: parentDir itself exists as a regular file (mkdir -p on a file path).
        // In both cases, remove the blocking file so mkdir can create the directory tree.
        const mkdirCode = (mkdirErr as NodeJS.ErrnoException).code
        if (mkdirCode === "ENOTDIR" || mkdirCode === "EEXIST") {
          // Walk up to find the file blocking directory creation
          const parts = parentDir.slice(_basePath.length + 1).split("/")
          let cur = _basePath
          for (const part of parts) {
            cur = resolve(cur, part)
            try {
              const info = await lstat(cur)
              if (info.isFile()) {
                const { unlink } = await import("node:fs/promises")
                await unlink(cur)
                break
              }
            } catch {
              break
            }
          }
          // Retry mkdir after removing the blocking file
          await mkdir(parentDir, { recursive: true })
        } else {
          throw mkdirErr
        }
      }
      const content = String(args.content)

      // Integrity check: detect LLM degeneration in the written content.
      // If the output is corrupted, warn the child so it can fix within its own iteration budget
      // instead of silently accepting garbage that wastes a full pipeline retry.
      const filePath = String(args.path)
      const integrityWarnings = checkWriteIntegrity(filePath, content)

      // ── Regression guard: detect function/class loss ──
      if (priorNames && priorNames.size > 0) {
        const newNames = extractDefinedNames(content)
        const lost = [...priorNames].filter(n => !newNames.has(n))
        if (lost.length > 0) {
          integrityWarnings.push(
            `FUNCTION LOSS: Your write REMOVED ${lost.length} existing definition(s): ${lost.join(", ")}. ` +
            `Other code likely calls these — your write has BROKEN the application. ` +
            `You MUST write_file again with ALL missing definitions restored.`
          )
        }
      }

      // ── Inline stub detection — real-time feedback at point of action ──
      // Instead of waiting for the verifier (which runs AFTER the child finishes),
      // detect stubs NOW so the child can fix them in its next iteration.
      if (/\.(js|jsx|ts|tsx|py)$/i.test(filePath) && content.length > 50) {
        const stubFindings = detectPlaceholderPatterns(content)
        if (stubFindings.length > 0) {
          integrityWarnings.push(
            `STUB/PLACEHOLDER CODE DETECTED — these functions need REAL implementation:\n` +
            stubFindings.map(f => `    • ${f}`).join("\n") + "\n" +
            `  Fix these NOW in your next write_file. The verifier WILL reject stub functions.`
          )
        }
      }

      // Separate structural errors (truncation, corruption, function loss)
      // from stub/placeholder detections — the latter need targeted guidance,
      // not panic-inducing "CORRUPTED" framing that causes full rewrites.
      const hasStructuralCorruption = hasStructuralIntegrityIssue(integrityWarnings)

      if (hasStructuralCorruption) {
        return (
          `⚠ WRITE REJECTED for ${filePath} — your output is CORRUPTED and was NOT saved:\n` +
          integrityWarnings.map(w => `  - ${w}`).join("\n") + "\n" +
          `The existing file was kept unchanged. ` +
          `Use read_file to inspect current content, then write_file again with corrected code.`
        )
      }

      // Commit only non-structural writes.
      await writeFile(target, content, "utf-8")

      if (integrityWarnings.length > 0) {
        const onlyStubDetections = !hasStructuralCorruption && integrityWarnings.every(w =>
          /STUB|PLACEHOLDER|degeneration|deferred-work|catch-all|inconsistent branch/i.test(w)
        )

        if (onlyStubDetections) {
          return (
            `\u26a0 WRITTEN WITH ISSUES to ${filePath} — stub/placeholder code detected:\n` +
            integrityWarnings.map(w => `  - ${w}`).join("\n") + "\n" +
            `The file was saved but contains incomplete code. ` +
            `Read the file, find the specific stub locations listed above, and write_file with those stubs replaced by REAL implementation. ` +
            `Keep ALL existing working code — only replace the stub portions.`
          )
        }
        return (
          `\u26a0 WRITTEN WITH ERRORS to ${filePath} — your output is CORRUPTED and must be fixed:\n` +
          integrityWarnings.map(w => `  - ${w}`).join("\n") + "\n" +
          `The file was saved but contains broken/degenerated code. ` +
          `Use read_file to see what you wrote, then write_file again with CORRECT content. ` +
          `Keep ALL existing working code intact.`
        )
      }

      return `Successfully wrote to ${filePath}`
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }
  },
}

// ── append_file ──────────────────────────────────────────────────

export const appendFileTool: Tool = {
  name: "append_file",
  description:
    "Append content to the end of a file. Creates the file if it doesn't exist. " +
    "Use this only for true append-only artifacts such as logs, notes, markdown sections, or generated transcripts. " +
    "Do NOT use this to patch existing code — prefer replace_in_file for surgical edits or write_file for full rewrites.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to append to" },
      content: { type: "string", description: "Content to append" },
    },
    required: ["path", "content"],
  },

  async execute(args) {
    try {
      const target = await safePathResolved(String(args.path))
      const filePath = String(args.path)
      const content = String(args.content)
      const parentDir = dirname(target)

      await mkdir(parentDir, { recursive: true })

      let existing = ""
      try {
        existing = await readFile(target, "utf-8")
      } catch {
        existing = ""
      }

      const combined = existing + content
      const integrityWarnings = checkWriteIntegrity(filePath, combined)

      if (hasStructuralIntegrityIssue(integrityWarnings)) {
        return (
          `Append rejected for ${filePath} — update was NOT saved due to structural issues:\n` +
          integrityWarnings.map(w => `  - ${w}`).join("\n") + "\n" +
          `Use read_file to inspect the current file, then retry with corrected content.`
        )
      }

      await appendFile(target, content, "utf-8")

      if (integrityWarnings.length > 0) {
        return (
          `Appended to ${filePath}, but issues were detected in the resulting file:\n` +
          integrityWarnings.map(w => `  - ${w}`).join("\n")
        )
      }

      return `Successfully appended to ${filePath}`
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }
  },
}

// ── Definition name extraction (for regression detection) ────────

/**
 * Extract function, class, and named constant definitions from source code.
 * Used to detect when a rewrite drops existing definitions that other code depends on.
 */
function extractDefinedNames(code: string): Set<string> {
  const names = new Set<string>()
  // function declarations: function name(
  for (const m of code.matchAll(/\bfunction\s+([a-zA-Z_$][\w$]*)\s*\(/g)) {
    if (m[1]) names.add(m[1])
  }
  // class declarations: class Name
  for (const m of code.matchAll(/\bclass\s+([a-zA-Z_$][\w$]*)/g)) {
    if (m[1]) names.add(m[1])
  }
  // const/let/var with function value: const name = function | const name = (
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:function|\(|[a-zA-Z_$][\w$]*\s*=>)/g)) {
    if (m[1]) names.add(m[1])
  }
  return names
}

// ── Write integrity check ────────────────────────────────────────

/**
 * Check written content for LLM degeneration / corruption patterns.
 * Returns a list of warnings (empty = content is OK).
 */
function checkWriteIntegrity(filePath: string, content: string): string[] {
  const warnings: string[] = []
  if (content.length < 50) return warnings

  const isCode = /\.(js|jsx|ts|tsx|py|rb|java|cs|go|rs|c|cpp|swift|kt|php|sh|bash|zsh)$/i.test(filePath)
  const isHtml = /\.html?$/i.test(filePath)

  if (isCode) {    // ── Pure gibberish detection ──
    // Catches LLM degeneration that produces entirely non-code text,
    // e.g. "[compacted \u0001 full COMPL'd PROMO].THISs''." or
    //      "UPDATE! OFFCHAIN FINAL SCRIPT! INSERT_GAME_PATCH"
    // These lack ANY valid programming keywords.
    const CODE_KEYWORD_RE = /\b(?:function|const|let|var|class|if|else|for|while|do|switch|case|return|import|export|require|module|try|catch|throw|new|this|typeof|instanceof|null|undefined|true|false|async|await|yield|=>|console|document|window)\b/
    if (!CODE_KEYWORD_RE.test(content)) {
      warnings.push(
        `GIBBERISH REJECTED: File contains NO valid code keywords — this is degenerated LLM output, not code. ` +
        `Do NOT write non-code text to code files. Use the think tool to plan, then write REAL code.`
      )
      return warnings // Early return — no point checking further
    }
    // Detect code-mixed-with-gibberish: closing brace/paren followed by a
    // trailing plain-language phrase (no typical code punctuation afterward).
    // This avoids false positives for valid lines like:
    //   if (!piece) throw new Error(`No piece at ${from}`);
    const brokenCodeRe = /[})\]][\s]*[a-z]{3,}(?:\s+[a-z]{3,}){2,}\s*$/i
    const lines = content.split("\n")
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length > 10 && brokenCodeRe.test(trimmed) &&
          !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("#")) {
        warnings.push(`Line contains gibberish mixed with code: "${trimmed.slice(0, 80)}"`)
        break
      }
    }

    // Detect unclosed braces (truncated/degenerated output)
    const opens = (content.match(/{/g) ?? []).length
    const closes = (content.match(/}/g) ?? []).length
    if (opens > closes + 2) {
      warnings.push(`${opens - closes} unclosed brace(s) — file appears truncated or corrupted`)
    }

    // Detect abrupt ending with non-code text
    const lastLine = lines.filter(l => l.trim().length > 0).pop()?.trim() ?? ""
    if (lastLine.length > 10 &&
        !/[});\]`'"\\]$/.test(lastLine) &&
        !/^(?:export|module\.exports|\/\/|#|\*)/i.test(lastLine) &&
        /[a-z]{3,}\s+[a-z]{3,}/i.test(lastLine)) {
      warnings.push(`File ends with non-code text: "${lastLine.slice(-60)}"`)
    }
  }

  if (isHtml) {
    // Detect unclosed attribute values
    const unclosedAttrRe = /\w+="[^"]{10,}(?:>|\n|$)/gm
    const unclosed = content.match(unclosedAttrRe)
    if (unclosed && unclosed.length > 0) {
      warnings.push(`Unclosed HTML attribute value: "${unclosed[0].trim().slice(0, 60)}"`)
    }

    // Detect attributes with code garbage
    const corruptAttrRe = /(?!style=)\w+="[^"]*[{};][^"]*"/g
    const corrupt = content.match(corruptAttrRe)
    if (corrupt && corrupt.length > 0) {
      warnings.push(`HTML attribute contains code garbage: "${corrupt[0].slice(0, 60)}"`)
    }
  }

  return warnings
}

/** Structural integrity issues must block writes to keep file state monotonic. */
function hasStructuralIntegrityIssue(warnings: readonly string[]): boolean {
  return warnings.some(w =>
    /unclosed brace|gibberish|truncated|non-code text|FUNCTION LOSS|Unclosed HTML attribute|code garbage/i.test(w),
  )
}

// ── replace_in_file ──────────────────────────────────────────────

export const replaceInFileTool: Tool = {
  name: "replace_in_file",
  description:
    "Replace a specific section of an existing file with new content. " +
    "Use this instead of write_file when you only need to change part of a file — " +
    "it preserves all other content and prevents function loss. " +
    "Provide old_string (the exact text to find and replace) and new_string (the replacement). " +
    "old_string must match EXACTLY (including whitespace/indentation). " +
    "If old_string appears more than once, only the first occurrence is replaced.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to edit" },
      old_string: { type: "string", description: "The exact text to find in the file (must match exactly, including whitespace)" },
      new_string: { type: "string", description: "The replacement text" },
    },
    required: ["path", "old_string", "new_string"],
  },

  async execute(args) {
    try {
      const target = await safePathResolved(String(args.path))
      const filePath = String(args.path)
      const oldStr = String(args.old_string)
      const newStr = String(args.new_string)

      // Read existing content
      let existing: string
      try {
        existing = await readFile(target, "utf-8")
      } catch {
        return `Error: File "${filePath}" does not exist. Use write_file to create new files.`
      }

      // Find the old string
      const idx = existing.indexOf(oldStr)
      if (idx === -1) {
        // Help debug: show a snippet around where it might be
        const firstLine = oldStr.split("\n")[0].trim()
        const approxIdx = existing.indexOf(firstLine)
        if (approxIdx !== -1) {
          const context = existing.slice(Math.max(0, approxIdx - 20), approxIdx + firstLine.length + 20)
          return (
            `Error: old_string not found as an exact match in "${filePath}". ` +
            `Found a partial match — the first line exists but surrounding whitespace/context differs. ` +
            `Nearby content: "${context.replace(/\n/g, "\\n").slice(0, 120)}". ` +
            `Use read_file to see the exact content, then retry with the precise text.`
          )
        }
        return (
          `Error: old_string not found in "${filePath}". ` +
          `The text you provided does not exist in the file. ` +
          `Use read_file to see the current content first.`
        )
      }

      // Perform the replacement (first occurrence only)
      const updated = existing.slice(0, idx) + newStr + existing.slice(idx + oldStr.length)

      // Run integrity checks on the modified file BEFORE committing.
      const integrityWarnings = checkWriteIntegrity(filePath, updated)

      // Stub detection on the replaced section
      if (/\.(js|jsx|ts|tsx|py)$/i.test(filePath) && newStr.length > 50) {
        const stubFindings = detectPlaceholderPatterns(newStr)
        if (stubFindings.length > 0) {
          integrityWarnings.push(
            `STUB/PLACEHOLDER in replaced section:\n` +
            stubFindings.map(f => `    • ${f}`).join("\n") + "\n" +
            `  Fix these NOW. The verifier WILL reject stub functions.`
          )
        }
      }

      if (hasStructuralIntegrityIssue(integrityWarnings)) {
        return (
          `Replace rejected in ${filePath} — update was NOT saved due to structural issues:\n` +
          integrityWarnings.map(w => `  - ${w}`).join("\n") + "\n" +
          `Use read_file to inspect the current file, then retry with corrected replacement text.`
        )
      }

      await writeFile(target, updated, "utf-8")

      if (integrityWarnings.length > 0) {
        return (
          `Replaced in ${filePath}, but issues detected:\n` +
          integrityWarnings.map(w => `  - ${w}`).join("\n")
        )
      }

      return `Successfully replaced in ${filePath}`
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
