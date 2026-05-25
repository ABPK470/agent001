/**
 * Attachment tools — let the agent inspect and import user-uploaded files.
 *
 * The agent never reaches into the server directly. Instead it calls the
 * {@link AttachmentService} interface installed on the {@link AgentHost}
 * by the server (or CLI). Three tools are exposed:
 *   - list_attachments    metadata listing for the current run
 *   - read_attachment     fetch text content (binaries refuse with hint)
 *   - import_attachment   copy bytes into the run sandbox
 *   - promote_attachment  promote a sandbox artifact into the attachment store
 *
 * All four are built via closure-factories that capture the host explicitly;
 * there is no ambient/`getActiveAgentHost()` access here.
 */

import { type AgentHost, type AttachmentStore } from "../host/index.js"
import type { Tool } from "../types.js"

function requireServiceFromHost(host: AgentHost): AttachmentStore {
  if (!host.attachments) {
    throw new Error(
      "Attachment service is not configured on this AgentHost. " +
      "Pass `attachments` to `configureAgent({...})`.",
    )
  }
  return host.attachments
}

const DEFAULT_READ_LIMIT_BYTES = 256 * 1024

// ── Schema constants (hoisted so factories share descriptions) ────

const LIST_ATTACHMENTS_DESCRIPTION =
  "List user-supplied attachment files available to this run. " +
  "Returns metadata only (id, name, media type, size, ingestion mode). " +
  "Use this before read_attachment / import_attachment to pick the right id. " +
  "Filter by `q` to narrow by name or purpose tag."

const LIST_ATTACHMENTS_PARAMETERS = {
  type: "object",
  properties: {
    q: { type: "string", description: "Optional substring filter on name / purpose tag." },
  },
} as const

const READ_ATTACHMENT_DESCRIPTION =
  "Read the text content of an attachment by id. " +
  "Best for text/* and application/json|csv|xml. Binary attachments are refused — " +
  "use import_attachment to copy them into the sandbox and process from there. " +
  `Output is truncated at ${DEFAULT_READ_LIMIT_BYTES} bytes by default; pass maxBytes to override. ` +
  "For large attachments, page through by passing the `nextOffset` from the previous call as `offset`."

const READ_ATTACHMENT_PARAMETERS = {
  type: "object",
  properties: {
    id:       { type: "string", description: "Attachment id (from list_attachments)." },
    maxBytes: { type: "number", description: "Truncate at this many bytes. Defaults to 262144." },
    offset:   { type: "number", description: "Byte offset to start reading from. Use the `nextOffset` returned by a previous call to page through large attachments." },
  },
  required: ["id"],
} as const

const IMPORT_ATTACHMENT_DESCRIPTION =
  "Copy an attachment into the current run sandbox so other tools can operate on it. " +
  "The destination must be a sandbox-relative path; the host refuses any path that " +
  "escapes the sandbox root. Returns the absolute sandbox path on success."

const IMPORT_ATTACHMENT_PARAMETERS = {
  type: "object",
  properties: {
    id:           { type: "string", description: "Attachment id (from list_attachments)." },
    destination:  { type: "string", description: "Sandbox-relative destination path, e.g. 'inputs/data.csv'." },
  },
  required: ["id", "destination"],
} as const

const PROMOTE_ATTACHMENT_DESCRIPTION =
  "Promote a file the agent produced inside the sandbox into the durable " +
  "attachment store. Use this when a generated artifact (report, CSV, " +
  "rendered image, etc.) should outlive the sandbox so the user can " +
  "download it later. The result is tagged source=generated and bound " +
  "to this run. Returns the new attachment id."

const PROMOTE_ATTACHMENT_PARAMETERS = {
  type: "object",
  properties: {
    sandboxPath: { type: "string", description: "Sandbox-relative path of the produced file." },
    mediaType:   { type: "string", description: "Optional MIME type override; inferred from extension if omitted." },
    purposeTag:  { type: "string", description: "Optional short label for the promotion (e.g. 'final-report')." },
  },
  required: ["sandboxPath"],
} as const

// ── Closure factories (no ambient state) ──────────────────────────

/** Factory: build a `list_attachments` tool bound to `host.attachments`. */
export function createListAttachmentsTool(host: AgentHost): Tool {
  return {
    name: "list_attachments",
    description: LIST_ATTACHMENTS_DESCRIPTION,
    parameters: LIST_ATTACHMENTS_PARAMETERS,
    async execute(args) {
      const svc = requireServiceFromHost(host)
      const q = typeof args["q"] === "string" ? (args["q"] as string) : undefined
      const rows = await svc.list(q ? { q } : undefined)
      if (rows.length === 0) return "No attachments are bound to this run."
      const lines = rows.map((r) =>
        `- id=${r.id}  name=${r.normalizedName}  type=${r.mediaType}  size=${r.sizeBytes}B  mode=${r.ingestionMode}`,
      )
      return [`Attachments (${rows.length}):`, ...lines].join("\n")
    },
  }
}

/** Factory: build a `read_attachment` tool bound to `host.attachments`. */
export function createReadAttachmentTool(host: AgentHost): Tool {
  return {
    name: "read_attachment",
    description: READ_ATTACHMENT_DESCRIPTION,
    parameters: READ_ATTACHMENT_PARAMETERS,
    async execute(args) {
      const svc = requireServiceFromHost(host)
      const id = String(args["id"] ?? "")
      if (!id) throw new Error("id is required")
      const maxBytes = typeof args["maxBytes"] === "number" ? Math.max(1, args["maxBytes"] as number) : DEFAULT_READ_LIMIT_BYTES
      const offset   = typeof args["offset"]   === "number" ? Math.max(0, args["offset"]   as number) : 0
      const result = await svc.read(id, { maxBytes, offset })
      if (result.kind === "binary") {
        return `Attachment ${id} is binary (${result.sizeBytes} bytes). Use import_attachment to copy it into the sandbox.`
      }
      const sliceEnd = result.offset + (result.text?.length ?? 0)
      const headerParts = [
        `Attachment ${id} (${result.sizeBytes}B`,
        `bytes ${result.offset}-${sliceEnd}`,
      ]
      if (result.nextOffset !== null) headerParts.push(`nextOffset=${result.nextOffset}`)
      else                            headerParts.push(`EOF`)
      const header = headerParts.join(", ") + "):"
      return [header, result.text ?? ""].join("\n")
    },
  }
}

/** Factory: build an `import_attachment` tool bound to `host.attachments`. */
export function createImportAttachmentTool(host: AgentHost): Tool {
  return {
    name: "import_attachment",
    description: IMPORT_ATTACHMENT_DESCRIPTION,
    parameters: IMPORT_ATTACHMENT_PARAMETERS,
    async execute(args) {
      const svc = requireServiceFromHost(host)
      const id          = String(args["id"] ?? "")
      const destination = String(args["destination"] ?? "")
      if (!id)          throw new Error("id is required")
      if (!destination) throw new Error("destination is required")
      const result = await svc.importToSandbox(id, destination)
      return `Imported ${id} → ${result.sandboxPath} (${result.sizeBytes} bytes).`
    },
  }
}

/** Factory: build a `promote_attachment` tool bound to `host.attachments`. */
export function createPromoteAttachmentTool(host: AgentHost): Tool {
  return {
    name: "promote_attachment",
    description: PROMOTE_ATTACHMENT_DESCRIPTION,
    parameters: PROMOTE_ATTACHMENT_PARAMETERS,
    async execute(args) {
      const svc = requireServiceFromHost(host)
      const sandboxPath = String(args["sandboxPath"] ?? "")
      if (!sandboxPath) throw new Error("sandboxPath is required")
      const mediaType  = typeof args["mediaType"]  === "string" ? (args["mediaType"]  as string) : undefined
      const purposeTag = typeof args["purposeTag"] === "string" ? (args["purposeTag"] as string) : undefined
      const meta = await svc.promoteFromSandbox(sandboxPath, {
        ...(mediaType  !== undefined ? { mediaType } : {}),
        ...(purposeTag !== undefined ? { purposeTag } : {}),
      })
      return `Promoted ${sandboxPath} → attachment id=${meta.id} (${meta.normalizedName}, ${meta.sizeBytes}B, ${meta.mediaType}).`
    },
  }
}
