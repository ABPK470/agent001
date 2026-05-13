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
import type { Tool } from "../types.js"

/** @internal — host-side wiring point. */
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
    `Output is truncated at ${DEFAULT_READ_LIMIT_BYTES} bytes by default; pass maxBytes to override.`,
  parameters: {
    type: "object",
    properties: {
      id:       { type: "string", description: "Attachment id (from list_attachments)." },
      maxBytes: { type: "number", description: "Truncate at this many bytes. Defaults to 262144." },
    },
    required: ["id"],
  },
  async execute(args) {
    const id = String(args["id"] ?? "")
    if (!id) throw new Error("id is required")
    const maxBytes = typeof args["maxBytes"] === "number" ? Math.max(1, args["maxBytes"] as number) : DEFAULT_READ_LIMIT_BYTES
    const result = await getService().read(id, { maxBytes })
    if (result.kind === "binary") {
      return `Attachment ${id} is binary (${result.sizeBytes} bytes). Use import_attachment to copy it into the sandbox.`
    }
    const header = result.truncated
      ? `Attachment ${id} (${result.sizeBytes}B, truncated to ${maxBytes}B):`
      : `Attachment ${id} (${result.sizeBytes}B):`
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
