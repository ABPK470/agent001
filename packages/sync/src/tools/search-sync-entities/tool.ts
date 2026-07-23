/**
 * `search_sync_entities` agent tool.
 */

import type { ExecutableTool, Tool, ToolMetadata } from "../../ports/host.js"
import { resolveSyncEntitySearch, searchEntities } from "../../runtime/orchestrator/index.js"
import {
  publishedEntityTypeHint,
  validatePublishedEntityType,
} from "../_shared/helpers.js"
import { parseEntityInstanceRef } from "../../core/scope/entity-instance-ref.js"
import type { SyncEntityId } from "../../domain/definition-selection.js"
import type { SyncRuntimeHost } from "../../ports/index.js"

// ── search_sync_entities ─────────────────────────────────────────

function buildSearchSyncEntitiesTool(host: SyncRuntimeHost): Tool {
  return {
    name: "search_sync_entities",
    description:
      "Search for ABI sync entity rows in a source environment (recipe root table). " +
      "Resolves by primary key when q is numeric or tableId=/id= form (e.g. '2545', 'table 2545', 'tableId=2545'). " +
      "Otherwise matches the display label column (e.g. core.Contract.name). " +
      "When the user already gave a numeric id, prefer sync_preview directly — only search to disambiguate names. " +
      "Do NOT use search_catalog for sync entity lookup — it returns unrelated warehouse tables.",
    parameters: {
      type: "object",
      properties: {
        entityType: {
          type: "string",
          description: `Published sync definition id. One of: ${publishedEntityTypeHint(host)}.`
        },
        source: {
          type: "string",
          description: "Source environment / MSSQL connection to search in (same as sync source)."
        },
        q: {
          type: "string",
          description:
            "Instance reference: numeric id, id key form (tableId=2545), or display-name fragment (ACSRawTest)."
        },
        mode: {
          type: "string",
          enum: ["auto", "name", "id"],
          description:
            "Lookup mode. Default auto: numeric / id-key q searches primary key; otherwise label column."
        },
        limit: {
          type: "number",
          description: "Max results (default 20, max 50).",
          default: 20
        }
      },
      required: ["entityType", "source", "q"]
    },
    async execute(args) {
      const entityType = String(args.entityType) as SyncEntityId
      const entityError = validatePublishedEntityType(host, entityType)
      if (entityError) return entityError
      const source = String(args.source).trim()
      const rawQ = String(args.q).trim()
      if (!rawQ) return "Error: q (search query) is required."
      const explicitMode = args.mode === "id" || args.mode === "name" ? args.mode : "auto"
      const { q, mode } = resolveSyncEntitySearch(rawQ, explicitMode)
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50)
      try {
        const hits = await searchEntities(host, entityType, source, q, limit, mode)
        if (hits.length === 0) {
          const parsed = parseEntityInstanceRef(rawQ)
          if (parsed.entityId && mode === "id") {
            return `No ${entityType} row with id=${parsed.entityId} in ${source}. Verify the id exists on the recipe root table.`
          }
          return `No ${entityType} entities matching "${rawQ}" in ${source} (${mode} lookup). Try a shorter fragment or verify the source environment.`
        }
        const lines = [`${hits.length} match(es) for ${entityType} "${q}" in ${source} (${mode}):`]
        for (const hit of hits) {
          lines.push(`  • id=${hit.id}${hit.name ? ` — ${hit.name}` : ""}`)
        }
        if (hits.length === 1) {
          lines.push("")
          lines.push(`Use entityId=${hits[0]!.id} in sync_preview.`)
        } else {
          lines.push("")
          lines.push("Multiple matches — pick the correct id or ask the user to disambiguate.")
        }
        return lines.join("\n")
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`
      }
    }
  }
}

export const searchSyncEntitiesToolMetadata: ToolMetadata = (() => {
  const stub = {} as SyncRuntimeHost
  const t = buildSearchSyncEntitiesTool(stub)
  return {
    name: t.name,
    description: t.description,
    parameters: t.parameters
  }
})()

export const searchSyncEntitiesTool = searchSyncEntitiesToolMetadata

export function createSearchSyncEntitiesTool(host: SyncRuntimeHost): ExecutableTool {
  return buildSearchSyncEntitiesTool(host)
}
