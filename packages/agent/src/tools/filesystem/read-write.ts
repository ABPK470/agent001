import { appendFile as fsAppendFile, mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { Tool } from "../../types.js"
import { checkWriteIntegrity, hasStructuralIntegrityIssue } from "../filesystem-integrity.js"
import { buildToolOutcome, safePathResolved } from "../filesystem-security.js"
import { executeWriteFile } from "./write-execute.js"

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
    return executeWriteFile(args)
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
