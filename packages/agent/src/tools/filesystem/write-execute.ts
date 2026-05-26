import { ToolControlDirective, ToolOutcomeSeverity } from "../../domain/index.js"
/**
 * write_file execution logic. Extracted from read-write.ts.
 *
 * @module
 */

import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { detectPlaceholderPatterns } from "../../application/core/governance.js"
import type { AgentHost } from "../../host/index.js"
import type { ToolResultEnvelope } from "../../types.js"
import { checkWriteIntegrity, extractDefinedNames, hasStructuralIntegrityIssue } from "../filesystem-integrity.js"
import { buildToolOutcome, safePathResolvedWith } from "../filesystem-security.js"

/**
 * Doctrine-shaped variant: run the write-file logic sourcing the sandbox
 * root from the provided {@link AgentHost} (no ambient state, no
 * runtime fallback).
 */
export function executeWriteFileWith(
  host: AgentHost,
  args: Record<string, unknown>,
): Promise<string | ToolResultEnvelope> {
  return executeWriteFileCore(args, {
    basePath: host.filesystem.basePath,
    resolveSafe: (p) => safePathResolvedWith(host, p),
  })
}

interface WriteFileCtx {
  basePath: string
  resolveSafe: (p: string) => Promise<string>
}

async function executeWriteFileCore(
  args: Record<string, unknown>,
  ctx: WriteFileCtx,
): Promise<string | ToolResultEnvelope> {
    try {
      // Use safePathResolved to prevent writing through symlinks that point outside workspace
      const target = await ctx.resolveSafe(String(args.path))
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
          const parts = parentDir.slice(ctx.basePath.length + 1).split("/")
          let cur = ctx.basePath
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
            severity: ToolOutcomeSeverity.Fatal,
            directive: ToolControlDirective.AbortRound,
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
            severity: ToolOutcomeSeverity.Recoverable,
            directive: ToolControlDirective.AbortRound,
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
              severity: ToolOutcomeSeverity.Recoverable,
              directive: ToolControlDirective.AbortRound,
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
            severity: ToolOutcomeSeverity.Fatal,
            directive: ToolControlDirective.AbortRound,
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
        severity: ToolOutcomeSeverity.Info,
        directive: ToolControlDirective.Continue,
        artifacts: [{ path: filePath, preservedExisting: false, requiresReadBeforeMutation: false }],
      })
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }
}
