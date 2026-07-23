/**
 * Shared helpers for sync agent tools.
 */
import {
  isPublishedSyncEntityType,
  listPublishedSyncDefinitionIds,
} from "../../runtime/published-definitions.js"
import { isSyncPublishRequiredError, PUBLISH_REQUIRED_CODE } from "../../domain/publish-readiness.js"
import type { SyncRuntimeHost } from "../../ports/index.js"

export function publishedEntityTypeHint(host: SyncRuntimeHost): string {
  try {
    const ids = listPublishedSyncDefinitionIds(host)
    return ids.length > 0 ? ids.join(", ") : "a published sync definition id"
  } catch {
    return "a published sync definition id"
  }
}

export function validatePublishedEntityType(host: SyncRuntimeHost, entityType: string): string | null {
  try {
    if (!isPublishedSyncEntityType(host, entityType)) {
      const known = listPublishedSyncDefinitionIds(host)
      return `Error: invalid entityType "${entityType}". Must be one of: ${known.join(", ") || "(none published)"}`
    }
    return null
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`
  }
}

export function formatSyncToolError(error: unknown): string {
  if (isSyncPublishRequiredError(error)) {
    return (
      `Error [${PUBLISH_REQUIRED_CODE}]: ${error.message} ` +
      `Do not retry preview/execute until the user Publishes from Entity Registry.`
    )
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}`
}
