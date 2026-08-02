/**
 * Tool argument validation against tools-resolved JSON Schema (v1 subset).
 */

export type SchemaFieldStatus = "valid" | "invalid" | "missing" | "unknown"

export type SchemaFieldMarker = {
  path: string
  status: SchemaFieldStatus
  message?: string
}

export type ToolSchemaValidation = {
  toolName: string
  markers: SchemaFieldMarker[]
  unknownFields: string[]
  missingRequired: string[]
}

type JsonSchema = {
  type?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
}

export function resolveToolSchema(
  tools: Array<{ name: string; parameters?: Record<string, unknown> }>,
  toolName: string,
): JsonSchema | null {
  const tool = tools.find((t) => t.name === toolName)
  if (!tool?.parameters) return null
  return tool.parameters as JsonSchema
}

export function validateToolArguments(
  tools: Array<{ name: string; parameters?: Record<string, unknown> }>,
  toolName: string,
  args: Record<string, unknown>,
): ToolSchemaValidation {
  const schema = resolveToolSchema(tools, toolName)
  const markers: SchemaFieldMarker[] = []
  const unknownFields: string[] = []
  const missingRequired: string[] = []

  if (!schema?.properties) {
    for (const key of Object.keys(args)) {
      markers.push({ path: key, status: "unknown" })
      unknownFields.push(key)
    }
    return { toolName, markers, unknownFields, missingRequired }
  }

  const required = new Set(schema.required ?? [])
  for (const key of required) {
    if (!(key in args)) {
      missingRequired.push(key)
      markers.push({ path: key, status: "missing", message: "required" })
    }
  }

  for (const [key, value] of Object.entries(args)) {
    const prop = schema.properties[key]
    if (!prop) {
      unknownFields.push(key)
      markers.push({ path: key, status: "unknown", message: "not in schema" })
      continue
    }
    const ok = valueMatchesSchema(value, prop)
    markers.push({
      path: key,
      status: ok ? "valid" : "invalid",
      message: ok ? undefined : `expected ${prop.type ?? "value"}`,
    })
  }

  return { toolName, markers, unknownFields, missingRequired }
}

function valueMatchesSchema(value: unknown, schema: JsonSchema): boolean {
  if (value === null || value === undefined) return !schema.required
  if (!schema.type) return true
  switch (schema.type) {
    case "string":
      return typeof value === "string"
    case "number":
    case "integer":
      return typeof value === "number"
    case "boolean":
      return typeof value === "boolean"
    case "array":
      return Array.isArray(value)
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value)
    default:
      return true
  }
}

export function isValidJsonText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (!(trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"'))) {
    return false
  }
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

export function statusMarkerClass(status: SchemaFieldStatus): string {
  switch (status) {
    case "valid":
      return "trace-schema-marker is-valid"
    case "invalid":
      return "trace-schema-marker is-invalid"
    case "missing":
      return "trace-schema-marker is-missing"
    default:
      return "trace-schema-marker is-unknown"
  }
}
