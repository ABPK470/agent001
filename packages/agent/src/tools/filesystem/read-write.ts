import { appendFile as fsAppendFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { detectPlaceholderPatterns } from "../../code-quality.js"
import type { Tool } from "../../types.js"
import { checkWriteIntegrity, extractDefinedNames, hasStructuralIntegrityIssue } from "../filesystem-integrity.js"
import { buildToolOutcome, getBasePath, safePathResolved } from "../filesystem-security.js"

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
      let priorNames: Set<string> | undefined
      let existingContent: string | null = null
      let hadExistingFile = false
      try {
        const existing = await readFile(target, "utf-8")
        hadExistingFile = true
        if (existing.length > 0) {
          // Only extract definition names from code files — applying this to
          // Markdown, JSON, YAML, etc. produces false positives (e.g. the word
          // "that" in a markdown sentence matching const/let/var patterns).
          if (isCodeFile) {
            priorNames = extractDefinedNames(existing)
          }
          // Cap at 24 KB — enough to fit any reasonable source file in the LLM context
          existingContent = existing.length <= 24576 ? existing : existing.slice(0, 24576) + "\n// [truncated — file exceeds 24 KB]"
        }
      } catch { /* file doesn't exist yet — no regression possible */ }

      // Auto-create parent directories (safe: target is already validated under _basePath)
      const parentDir = dirname(target)
      try {
        await mkdir(parentDir, { recursive: true })
      } catch (mkdirErr) {
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

      // ── Inline stub detection ──
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
              hadExistingFile ? "The existing file was kept unchanged." : "No file was written because the proposed content was structurally invalid.",
              hadExistingFile && existingContent
                ? `Write_file again with ALL the definitions listed below preserved, plus your fix. Do NOT call read_file — the current content is already provided here:\n\`\`\`\n${existingContent}\n\`\`\``
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
              hadExistingFile ? "The existing file was kept unchanged." : "No file was written because code artifacts must not be created with placeholder logic.",
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
