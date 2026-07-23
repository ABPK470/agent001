/**
 * `list_sync_definitions` agent tool.
 */

import type { ExecutableTool, Tool, ToolMetadata } from "../../ports/host.js"
import {
  listPublishedSyncDefinitionsForHost
} from "../../runtime/published-definitions.js"
import type { SyncRuntimeHost } from "../../ports/index.js"

// ── list_sync_definitions ────────────────────────────────────────

function buildListSyncDefinitionsTool(host: SyncRuntimeHost): Tool {
  return {
    name: "list_sync_definitions",
    description:
      "List published ABI sync definitions from the runtime bundle — ids, display names, root tables, and recipe tables. " +
      "Call this to discover what entity types exist before sync_preview or sync_diff_scan. Authority is the published bundle, not hardcoded names.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      try {
        const defs = listPublishedSyncDefinitionsForHost(host)
        if (defs.length === 0) return "No published sync definitions loaded."
        const lines = [`Published sync definitions (${defs.length}):`]
        for (const def of defs.sort((a, b) => a.id.localeCompare(b.id))) {
          const tables = def.metadata.tables.map((t) => t.name)
          lines.push(`  • ${def.id} — "${def.displayName}"`)
          lines.push(`    root: ${def.rootTable} (${def.idColumn})`)
          if (tables.length > 0) {
            lines.push(`    tables: ${tables.join(", ")}`)
          }
        }
        lines.push("")
        lines.push("When the user describes scope in business language, call resolve_sync_scope next.")
        return lines.join("\n")
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`
      }
    }
  }
}

export const listSyncDefinitionsToolMetadata: ToolMetadata = (() => {
  const stub = {} as SyncRuntimeHost
  const t = buildListSyncDefinitionsTool(stub)
  return { name: t.name, description: t.description, parameters: t.parameters }
})()

export const listSyncDefinitionsTool = listSyncDefinitionsToolMetadata

export function createListSyncDefinitionsTool(host: SyncRuntimeHost): ExecutableTool {
  return buildListSyncDefinitionsTool(host)
}
