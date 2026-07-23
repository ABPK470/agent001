/**
 * `resolve_sync_scope` agent tool.
 */

import type { ExecutableTool, Tool, ToolMetadata } from "../../ports/host.js"
import {
  listPublishedSyncDefinitionsForHost
} from "../../runtime/published-definitions.js"
import {
  formatSyncScopeResolution,
  resolveSyncScope
} from "../../core/scope/sync-scope-resolution.js"
import type { SyncRuntimeHost } from "../../ports/index.js"

// ── resolve_sync_scope ───────────────────────────────────────────

function buildResolveSyncScopeTool(host: SyncRuntimeHost): Tool {
  return {
    name: "resolve_sync_scope",
    description:
      "Map a natural-language scope query (e.g. business terms the user used) to published sync definition ids. " +
      "Uses definition ids, display names, and recipe table names from the bundle. Returns ranked matches and flags ambiguity. " +
      "Call before sync_diff_scan when entityType is unclear.",
    parameters: {
      type: "object",
      properties: {
        q: {
          type: "string",
          description: "Scope phrase from the user goal — what to compare (exclude environment names)."
        }
      },
      required: ["q"]
    },
    async execute(args) {
      const q = String(args.q ?? "").trim()
      if (!q) return "Error: q (scope query) is required."
      try {
        const defs = listPublishedSyncDefinitionsForHost(host)
        const resolution = resolveSyncScope(q, defs)
        return formatSyncScopeResolution(resolution)
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`
      }
    }
  }
}

export const resolveSyncScopeToolMetadata: ToolMetadata = (() => {
  const stub = {} as SyncRuntimeHost
  const t = buildResolveSyncScopeTool(stub)
  return { name: t.name, description: t.description, parameters: t.parameters }
})()

export const resolveSyncScopeTool = resolveSyncScopeToolMetadata

export function createResolveSyncScopeTool(host: SyncRuntimeHost): ExecutableTool {
  return buildResolveSyncScopeTool(host)
}
