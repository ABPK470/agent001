import type { EntityType } from "@mia/sync"

export type DecodePreviewError = { ok: false; error: string }

export type PreviewBody = {
  entityType: EntityType
  entityId: string | number
  source: string
  target: string
  force?: boolean
  enabledOptionalTables?: string[]
}

export type DecodePreviewResult = { ok: true; value: PreviewBody } | DecodePreviewError

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readString(value: unknown, field: string): string | DecodePreviewError {
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, error: `${field} must be a non-empty string` }
  }
  return value.trim()
}

/** Decode POST /api/sync/preview body from unknown wire JSON. */
export function decodePreviewBody(body: unknown): DecodePreviewResult {
  if (!isRecord(body)) return { ok: false, error: "body must be a JSON object" }

  const entityType = readString(body.entityType, "entityType")
  if (typeof entityType !== "string") return entityType

  const source = readString(body.source, "source")
  if (typeof source !== "string") return source

  const target = readString(body.target, "target")
  if (typeof target !== "string") return target

  const entityIdRaw = body.entityId
  if (typeof entityIdRaw !== "string" && typeof entityIdRaw !== "number") {
    return { ok: false, error: "entityId must be a string or number" }
  }

  const force = body.force === undefined ? undefined : Boolean(body.force)

  let enabledOptionalTables: string[] | undefined
  if (body.enabledOptionalTables !== undefined) {
    if (!Array.isArray(body.enabledOptionalTables)) {
      return { ok: false, error: "enabledOptionalTables must be an array of strings" }
    }
    enabledOptionalTables = []
    for (const item of body.enabledOptionalTables) {
      if (typeof item !== "string" || item.trim() === "") {
        return { ok: false, error: "enabledOptionalTables must contain non-empty strings" }
      }
      enabledOptionalTables.push(item.trim())
    }
  }

  return {
    ok: true,
    value: {
      entityType: entityType as EntityType,
      entityId: entityIdRaw,
      source,
      target,
      ...(force !== undefined ? { force } : {}),
      ...(enabledOptionalTables ? { enabledOptionalTables } : {})
    }
  }
}
