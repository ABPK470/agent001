import { ToolControlDirective, ToolOutcomeSeverity } from "@mia/agent"
import { appendFile as fsAppendFile, mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { AgentHost } from "../../host/index.js"
import type { Tool } from "../../types.js"
import { checkWriteIntegrity, hasStructuralIntegrityIssue } from "../filesystem-integrity.js"
import { buildToolOutcome, safePathResolvedWith } from "../filesystem-security.js"
import { executeWriteFileWith } from "./write-execute.js"

// ── read_file ────────────────────────────────────────────────────

const READ_FILE_DESCRIPTION =
  "Read the contents of a file. Returns the full text content. " +
  "Paths are relative to the working directory."

const READ_FILE_PARAMETERS = {
  type: "object",
  properties: {
    path: { type: "string", description: "Path to the file to read" },
  },
  required: ["path"],
} as const

/** Factory: build a `read_file` tool bound to `host.filesystem.basePath`. */
export function createReadFileTool(host: AgentHost): Tool {
  return {
    name: "read_file",
    description: READ_FILE_DESCRIPTION,
    parameters: READ_FILE_PARAMETERS,

    async execute(args) {
      try {
        const content = await readFile(await safePathResolvedWith(host, String(args.path)), "utf-8")
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
}

// ── append_file ──────────────────────────────────────────────────

const APPEND_FILE_DESCRIPTION =
  "Append content to the end of a file. Creates the file if it doesn't exist. " +
  "Use this only for true append-only artifacts such as logs, notes, markdown sections, or generated transcripts. " +
  "Do NOT use this to patch existing code — prefer replace_in_file for surgical edits or write_file for full rewrites."

const APPEND_FILE_PARAMETERS = {
  type: "object",
  properties: {
    path: { type: "string", description: "Path to append to" },
    content: { type: "string", description: "Content to append" },
  },
  required: ["path", "content"],
} as const

async function executeAppendFile(
  args: Record<string, unknown>,
  resolveSafe: (p: string) => Promise<string>,
) {
  try {
    const target = await resolveSafe(String(args.path))
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
          severity: ToolOutcomeSeverity.Fatal,
          directive: ToolControlDirective.AbortRound,
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
          severity: ToolOutcomeSeverity.Recoverable,
          directive: ToolControlDirective.AbortRound,
          errorCode: "artifact_incomplete_mutation",
          details: integrityWarnings,
          artifacts: [{ path: filePath, preservedExisting: false, requiresReadBeforeMutation: true }],
        },
      )
    }

    return buildToolOutcome(`Successfully appended to ${filePath}`, {
      ok: true,
      severity: ToolOutcomeSeverity.Info,
      directive: ToolControlDirective.Continue,
      artifacts: [{ path: filePath, preservedExisting: false, requiresReadBeforeMutation: false }],
    })
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

// ── Doctrine-shaped factories (write_file + append_file) ─────────

const WRITE_FILE_DESCRIPTION =
  "Write content to a file. Creates the file if it doesn't exist. " +
  "WARNING: This REPLACES the entire file content — it does NOT append. " +
  "To add code to an existing file, you MUST include all existing content plus your additions. " +
  "Paths are relative to the working directory."

const WRITE_FILE_PARAMETERS = {
  type: "object",
  properties: {
    path: { type: "string", description: "Path to write to" },
    content: { type: "string", description: "Content to write" },
  },
  required: ["path", "content"],
} as const

/** Factory: build a `write_file` tool bound to `host.filesystem.basePath`. */
export function createWriteFileTool(host: AgentHost): Tool {
  return {
    name: "write_file",
    description: WRITE_FILE_DESCRIPTION,
    parameters: WRITE_FILE_PARAMETERS,
    async execute(args) {
      return executeWriteFileWith(host, args)
    },
  }
}

/** Factory: build an `append_file` tool bound to `host.filesystem.basePath`. */
export function createAppendFileTool(host: AgentHost): Tool {
  return {
    name: "append_file",
    description: APPEND_FILE_DESCRIPTION,
    parameters: APPEND_FILE_PARAMETERS,
    async execute(args) {
      return executeAppendFile(args, (p) => safePathResolvedWith(host, p))
    },
  }
}
