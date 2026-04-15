/**
 * Filesystem tools — let the agent read, write, and list files.
 *
 * Security: 4-layer path validation in filesystem-security.ts.
 * Integrity: Write degeneration / corruption detection in filesystem-integrity.ts.
 *
 * Delete protection:
 *   No delete tool is exposed. Shell blocklist prevents rm on sensitive paths.
 *   write_file only creates/overwrites — no unlink/rmdir.
 */

import { appendFile as fsAppendFile, lstat, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { detectPlaceholderPatterns } from "../code-quality.js"
import type { Tool } from "../types.js"
import { checkWriteIntegrity, extractDefinedNames, hasStructuralIntegrityIssue } from "./filesystem-integrity.js"
import { buildToolOutcome, getBasePath, safePath, safePathResolved } from "./filesystem-security.js"

// Re-export for backward compatibility
export { setBasePath } from "./filesystem-security.js"

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
      const filePath = String(args.path)
      const isCodeFile = /\.(js|jsx|ts|tsx|py)$/i.test(filePath)

      // ── Regression guard: snapshot existing file before overwrite ──
      // If the file already exists, extract its defined names so we can detect
      // function/class loss after writing. This catches destructive rewrites
      // where the child drops existing functions that other code depends on.
      let priorNames: Set<string> | undefined
      let hadExistingFile = false
      try {
        const existing = await readFile(target, "utf-8")
        hadExistingFile = true
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
          const parts = parentDir.slice(getBasePath().length + 1).split("/")
          let cur = getBasePath()
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
        return buildToolOutcome(
          `WRITE REJECTED for ${filePath} — the mutation was blocked and the existing file was preserved.`,
          {
            ok: false,
            severity: "fatal",
            directive: "abort_round",
            errorCode: "artifact_integrity_violation",
            details: [
              ...integrityWarnings,
              hadExistingFile
                ? "The existing file was kept unchanged."
                : "No file was written because the proposed content was structurally invalid.",
              hadExistingFile
                ? "Use read_file to inspect current content before any further mutation attempt."
                : "Plan a corrected full write and retry; there is no current file to inspect.",
            ],
            artifacts: [{ path: filePath, preservedExisting: hadExistingFile, requiresReadBeforeMutation: hadExistingFile }],
            retryable: true,
          },
        )
      }

      const onlyStubDetections = integrityWarnings.length > 0 && integrityWarnings.every(w =>
        /STUB|PLACEHOLDER|degeneration|deferred-work|catch-all|inconsistent branch/i.test(w),
      )

      if (isCodeFile && onlyStubDetections) {
        return buildToolOutcome(
          `WRITE REJECTED for ${filePath} — incomplete placeholder/stub logic was blocked before commit.`,
          {
            ok: false,
            severity: "recoverable",
            directive: "abort_round",
            errorCode: "artifact_incomplete_mutation",
            details: [
              ...integrityWarnings,
              hadExistingFile
                ? "The existing file was kept unchanged."
                : "No file was written because code artifacts must not be created with placeholder logic.",
              "Plan the full implementation first, then write or replace the completed code in one pass.",
            ],
            artifacts: [{ path: filePath, preservedExisting: hadExistingFile, requiresReadBeforeMutation: hadExistingFile }],
            retryable: true,
          },
        )
      }

      // Commit only non-structural writes.
      await writeFile(target, content, "utf-8")

      if (integrityWarnings.length > 0) {
        if (onlyStubDetections) {
          return buildToolOutcome(
            `WRITTEN WITH ISSUES to ${filePath} — the file was saved but still contains incomplete logic.`,
            {
              ok: false,
              severity: "recoverable",
              directive: "abort_round",
              errorCode: "artifact_incomplete_mutation",
              details: [
                ...integrityWarnings,
                "Read the file you just wrote, then replace only the stub portions with real implementation.",
              ],
              artifacts: [{ path: filePath, preservedExisting: false, requiresReadBeforeMutation: true }],
              retryable: true,
            },
          )
        }
        return buildToolOutcome(
          `WRITTEN WITH ERRORS to ${filePath} — the file was saved with invalid content that must be repaired before more work continues.`,
          {
            ok: false,
            severity: "fatal",
            directive: "abort_round",
            errorCode: "artifact_corrupted_mutation",
            details: [
              ...integrityWarnings,
              "Read the saved file before attempting another mutation so the next edit repairs the actual current state.",
            ],
            artifacts: [{ path: filePath, preservedExisting: false, requiresReadBeforeMutation: true }],
            retryable: true,
          },
        )
      }

      return buildToolOutcome(`Successfully wrote to ${filePath}`, {
        ok: true,
        severity: "info",
        directive: "continue",
        artifacts: [{ path: filePath, preservedExisting: false, requiresReadBeforeMutation: false }],
      })
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
        return buildToolOutcome(
          `APPEND REJECTED for ${filePath} — the update was blocked due to structural integrity issues.`,
          {
            ok: false,
            severity: "fatal",
            directive: "abort_round",
            errorCode: "artifact_integrity_violation",
            details: [...integrityWarnings, "Use read_file to inspect the current file before any new append or rewrite."],
            artifacts: [{ path: filePath, preservedExisting: true, requiresReadBeforeMutation: true }],
          },
        )
      }

      await fsAppendFile(target, content, "utf-8")

      if (integrityWarnings.length > 0) {
        return buildToolOutcome(
          `APPENDED WITH ISSUES to ${filePath} — inspect the resulting file before continuing.`,
          {
            ok: false,
            severity: "recoverable",
            directive: "abort_round",
            errorCode: "artifact_incomplete_mutation",
            details: integrityWarnings,
            artifacts: [{ path: filePath, preservedExisting: false, requiresReadBeforeMutation: true }],
          },
        )
      }

      return buildToolOutcome(`Successfully appended to ${filePath}`, {
        ok: true,
        severity: "info",
        directive: "continue",
        artifacts: [{ path: filePath, preservedExisting: false, requiresReadBeforeMutation: false }],
      })
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }
  },
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
      const isCodeFile = /\.(js|jsx|ts|tsx|py)$/i.test(filePath)

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
        return buildToolOutcome(
          `REPLACE REJECTED for ${filePath} — the replacement was blocked due to structural integrity issues.`,
          {
            ok: false,
            severity: "fatal",
            directive: "abort_round",
            errorCode: "artifact_integrity_violation",
            details: [...integrityWarnings, "Use read_file to inspect the current file before another replacement attempt."],
            artifacts: [{ path: filePath, preservedExisting: true, requiresReadBeforeMutation: true }],
          },
        )
      }

      const onlyStubDetections = integrityWarnings.length > 0 && integrityWarnings.every(w =>
        /STUB|PLACEHOLDER|degeneration|deferred-work|catch-all|inconsistent branch/i.test(w),
      )

      if (isCodeFile && onlyStubDetections) {
        return buildToolOutcome(
          `REPLACE REJECTED for ${filePath} — incomplete placeholder/stub logic was blocked before commit.`,
          {
            ok: false,
            severity: "recoverable",
            directive: "abort_round",
            errorCode: "artifact_incomplete_mutation",
            details: [
              ...integrityWarnings,
              "The existing file was kept unchanged.",
              "Read the current file and replace the incomplete section with fully implemented logic in one pass.",
            ],
            artifacts: [{ path: filePath, preservedExisting: true, requiresReadBeforeMutation: true }],
          },
        )
      }

      await writeFile(target, updated, "utf-8")

      if (integrityWarnings.length > 0) {
        return buildToolOutcome(
          `REPLACED WITH ISSUES in ${filePath} — inspect the saved file before continuing.`,
          {
            ok: false,
            severity: "recoverable",
            directive: "abort_round",
            errorCode: "artifact_incomplete_mutation",
            details: integrityWarnings,
            artifacts: [{ path: filePath, preservedExisting: false, requiresReadBeforeMutation: true }],
          },
        )
      }

      return buildToolOutcome(`Successfully replaced in ${filePath}`, {
        ok: true,
        severity: "info",
        directive: "continue",
        artifacts: [{ path: filePath, preservedExisting: false, requiresReadBeforeMutation: false }],
      })
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
          const rel = parentDir.replace(getBasePath(), ".") || "."
          return `Error: "${requestedPath}" does not exist. Contents of ${rel}: ${items}`
        } catch {
          return `Error: "${requestedPath}" does not exist.`
        }
      }
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }
  },
}
