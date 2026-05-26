import { readdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { ToolControlDirective, ToolOutcomeSeverity } from "../../domain/index.js"
import { detectPlaceholderPatterns } from "../../governance/index.js"
import type { AgentHost } from "../../host/index.js"
import type { Tool } from "../../types.js"
import { checkWriteIntegrity, hasStructuralIntegrityIssue } from "../filesystem-integrity.js"
import { buildToolOutcome, safePathResolvedWith, safePathWith } from "../filesystem-security.js"

// ── replace_in_file ──────────────────────────────────────────────

const REPLACE_IN_FILE_DESCRIPTION =
  "Replace a specific section of an existing file with new content. " +
  "Use this instead of write_file when you only need to change part of a file — " +
  "it preserves all other content and prevents function loss. " +
  "Provide old_string (the exact text to find and replace) and new_string (the replacement). " +
  "old_string must match EXACTLY (including whitespace/indentation). " +
  "If old_string appears more than once, only the first occurrence is replaced."

const REPLACE_IN_FILE_PARAMETERS = {
  type: "object",
  properties: {
    path: { type: "string", description: "Path to the file to edit" },
    old_string: { type: "string", description: "The exact text to find in the file (must match exactly, including whitespace)" },
    new_string: { type: "string", description: "The replacement text" },
  },
  required: ["path", "old_string", "new_string"],
} as const

async function executeReplaceInFile(
  args: Record<string, unknown>,
  resolveSafe: (p: string) => Promise<string>,
) {
  try {
    const target = await resolveSafe(String(args.path))
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
          severity: ToolOutcomeSeverity.Fatal,
          directive: ToolControlDirective.AbortRound,
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
          severity: ToolOutcomeSeverity.Recoverable,
          directive: ToolControlDirective.AbortRound,
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
          severity: ToolOutcomeSeverity.Recoverable,
          directive: ToolControlDirective.AbortRound,
          errorCode: "artifact_incomplete_mutation",
          details: integrityWarnings,
          artifacts: [{ path: filePath, preservedExisting: false, requiresReadBeforeMutation: true }],
        },
      )
    }

    return buildToolOutcome(`Successfully replaced in ${filePath}`, {
      ok: true,
      severity: ToolOutcomeSeverity.Info,
      directive: ToolControlDirective.Continue,
      artifacts: [{ path: filePath, preservedExisting: false, requiresReadBeforeMutation: false }],
    })
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

/** Factory variant of `replace_in_file` bound to `host.filesystem.basePath`. */
export function createReplaceInFileTool(host: AgentHost): Tool {
  return {
    name: "replace_in_file",
    description: REPLACE_IN_FILE_DESCRIPTION,
    parameters: REPLACE_IN_FILE_PARAMETERS,
    async execute(args) {
      return executeReplaceInFile(args, (p) => safePathResolvedWith(host, p))
    },
  }
}

// ── list_directory ───────────────────────────────────────────────

const LIST_DIRECTORY_DESCRIPTION =
  "List the contents of a directory. Returns file and folder names. " +
  "Folders end with /. Paths are relative to the working directory."

const LIST_DIRECTORY_PARAMETERS = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Directory path (default: current directory)",
    },
  },
} as const

async function executeListDirectory(
  args: Record<string, unknown>,
  host: AgentHost,
) {
  try {
    const dir = await safePathResolvedWith(host, String(args.path ?? "."))
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
      const requestedPath = String(args.path ?? ".")
      const parentDir = dirname(safePathWith(host, requestedPath))
      try {
        const parentEntries = await readdir(parentDir)
        const items = parentEntries.slice(0, 30).join(", ")
        const rel = parentDir.replace(host.filesystem.basePath, ".") || "."
        return `Error: "${requestedPath}" does not exist. Contents of ${rel}: ${items}`
      } catch {
        return `Error: "${requestedPath}" does not exist.`
      }
    }
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

/** Factory variant of `list_directory` bound to `host.filesystem.basePath`. */
export function createListDirectoryTool(host: AgentHost): Tool {
  return {
    name: "list_directory",
    description: LIST_DIRECTORY_DESCRIPTION,
    parameters: LIST_DIRECTORY_PARAMETERS,
    async execute(args) {
      return executeListDirectory(args, host)
    },
  }
}
