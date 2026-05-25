/**
 * Attachment tools — let the agent inspect and import user-uploaded files.
 *
 * The agent never reaches into the server directly. Instead it calls the
 * {@link AttachmentService} interface installed on the active runtime by
 * the host (server / CLI). When no service is installed we surface a
 * clear error so misconfiguration is obvious.
 *
 * Three tools are exposed:
 *   - list_attachments    metadata listing for the current run
 *   - read_attachment     fetch text content (binaries refuse with hint)
 *   - import_attachment   copy bytes into the run sandbox
 */

import { currentRuntime, type AttachmentService } from "../agent-runtime.js"
import type { AgentHost } from "../host/index.js"
import type { Tool } from "../types.js"

/**
 * @deprecated Doctrine: prefer `configureAgent({ attachments })` + the
 * `create*AttachmentTool` factories below. See docs/doctrine.md §6.
 * @internal
 */
export function setAttachmentService(service: AttachmentService | null): void {
  currentRuntime().attachments.service = service
}

function getService(): AttachmentService {
  const svc = currentRuntime().attachments.service
  if (!svc) {
    throw new Error(
      "Attachment service is not configured for this runtime. " +
      "This usually means the host (server) did not install one at boot.",
    )
  }
  return svc
}

function requireServiceFromHost(host: AgentHost): AttachmentService {
  if (!host.attachments) {
    throw new Error(
      "Attachment service is not configured on this AgentHost. " +
      "Pass `attachments` to `configureAgent({...})`.",
    )
  }
  return host.attachments
}

const DEFAULT_READ_LIMIT_BYTES = 256 * 1024

export const listAttachmentsTool: Tool = {
  name: "list_attachments",
  description:
    "List user-supplied attachment files available to this run. " +
    "Returns metadata only (id, name, media type, size, ingestion mode). " +
    "Use this before read_attachment / import_attachment to pick the right id. " +
    "Filter by `q` to narrow by name or purpose tag.",
  parameters: {
    type: "object",
    properties: {
      q: { type: "string", description: "Optional substring filter on name / purpose tag." },
    },
  },
  async execute(args) {
    const q = typeof args["q"] === "string" ? (args["q"] as string) : undefined
    const rows = await getService().list(q ? { q } : undefined)
    if (rows.length === 0) return "No attachments are bound to this run."
    const lines = rows.map((r) =>
      `- id=${r.id}  name=${r.normalizedName}  type=${r.mediaType}  size=${r.sizeBytes}B  mode=${r.ingestionMode}`,
    )
    return [`Attachments (${rows.length}):`, ...lines].join("\n")
  },
}

export const readAttachmentTool: Tool = {
  name: "read_attachment",
  description:
    "Read the text content of an attachment by id. " +
    "Best for text/* and application/json|csv|xml. Binary attachments are refused — " +
    "use import_attachment to copy them into the sandbox and process from there. " +
    `Output is truncated at ${DEFAULT_READ_LIMIT_BYTES} bytes by default; pass maxBytes to override. ` +
    "For large attachments, page through by passing the `nextOffset` from the previous call as `offset`.",
  parameters: {
    type: "object",
    properties: {
      id:       { type: "string", description: "Attachment id (from list_attachments)." },
      maxBytes: { type: "number", description: "Truncate at this many bytes. Defaults to 262144." },
      offset:   { type: "number", description: "Byte offset to start reading from. Use the `nextOffset` returned by a previous call to page through large attachments." },
    },
    required: ["id"],
  },
  async execute(args) {
    const id = String(args["id"] ?? "")
    if (!id) throw new Error("id is required")
    const maxBytes = typeof args["maxBytes"] === "number" ? Math.max(1, args["maxBytes"] as number) : DEFAULT_READ_LIMIT_BYTES
    const offset   = typeof args["offset"]   === "number" ? Math.max(0, args["offset"]   as number) : 0
    const result = await getService().read(id, { maxBytes, offset })
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

export const importAttachmentTool: Tool = {
  name: "import_attachment",
  description:
    "Copy an attachment into the current run sandbox so other tools can operate on it. " +
    "The destination must be a sandbox-relative path; the host refuses any path that " +
    "escapes the sandbox root. Returns the absolute sandbox path on success.",
  parameters: {
    type: "object",
    properties: {
      id:           { type: "string", description: "Attachment id (from list_attachments)." },
      destination:  { type: "string", description: "Sandbox-relative destination path, e.g. 'inputs/data.csv'." },
    },
    required: ["id", "destination"],
  },
  async execute(args) {
    const id          = String(args["id"] ?? "")
    const destination = String(args["destination"] ?? "")
    if (!id)          throw new Error("id is required")
    if (!destination) throw new Error("destination is required")
    const result = await getService().importToSandbox(id, destination)
    return `Imported ${id} → ${result.sandboxPath} (${result.sizeBytes} bytes).`
  },
}

export const promoteAttachmentTool: Tool = {
  name: "promote_attachment",
  description:
    "Promote a file the agent produced inside the sandbox into the durable " +
    "attachment store. Use this when a generated artifact (report, CSV, " +
    "rendered image, etc.) should outlive the sandbox so the user can " +
    "download it later. The result is tagged source=generated and bound " +
    "to this run. Returns the new attachment id.",
  parameters: {
    type: "object",
    properties: {
      sandboxPath: { type: "string", description: "Sandbox-relative path of the produced file." },
      mediaType:   { type: "string", description: "Optional MIME type override; inferred from extension if omitted." },
      purposeTag:  { type: "string", description: "Optional short label for the promotion (e.g. 'final-report')." },
    },
    required: ["sandboxPath"],
  },
  async execute(args) {
    const sandboxPath = String(args["sandboxPath"] ?? "")
    if (!sandboxPath) throw new Error("sandboxPath is required")
    const mediaType  = typeof args["mediaType"]  === "string" ? (args["mediaType"]  as string) : undefined
    const purposeTag = typeof args["purposeTag"] === "string" ? (args["purposeTag"] as string) : undefined
    const meta = await getService().promoteFromSandbox(sandboxPath, {
      ...(mediaType  !== undefined ? { mediaType } : {}),
      ...(purposeTag !== undefined ? { purposeTag } : {}),
    })
    return `Promoted ${sandboxPath} → attachment id=${meta.id} (${meta.normalizedName}, ${meta.sizeBytes}B, ${meta.mediaType}).`
  },
}

// ── Doctrine-shaped factories (host-bound, no ambient state) ─────
//
// Each factory below returns the same tool shape as the ambient export
// above, but bound to an explicit AgentHost. Existing ambient tools keep
// working unchanged for callers that have not migrated yet.

/** Factory variant of {@link listAttachmentsTool} bound to `host.attachments`. */
export function createListAttachmentsTool(host: AgentHost): Tool {
  return {
    name: listAttachmentsTool.name,
    description: listAttachmentsTool.description,
    parameters: listAttachmentsTool.parameters,
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

/** Factory variant of {@link readAttachmentTool} bound to `host.attachments`. */
export function createReadAttachmentTool(host: AgentHost): Tool {
  return {
    name: readAttachmentTool.name,
    description: readAttachmentTool.description,
    parameters: readAttachmentTool.parameters,
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

/** Factory variant of {@link importAttachmentTool} bound to `host.attachments`. */
export function createImportAttachmentTool(host: AgentHost): Tool {
  return {
    name: importAttachmentTool.name,
    description: importAttachmentTool.description,
    parameters: importAttachmentTool.parameters,
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

/** Factory variant of {@link promoteAttachmentTool} bound to `host.attachments`. */
export function createPromoteAttachmentTool(host: AgentHost): Tool {
  return {
    name: promoteAttachmentTool.name,
    description: promoteAttachmentTool.description,
    parameters: promoteAttachmentTool.parameters,
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