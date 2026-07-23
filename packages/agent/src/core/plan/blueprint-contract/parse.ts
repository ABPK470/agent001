/**
 * Blueprint contract block parsing — JSON normalizers and the parser.
 * Extracted from blueprint-contract.ts.
 *
 * @module
 */

import type {
  BlueprintFileSpec,
  BlueprintFunctionSpec,
  BlueprintSharedTypeSpec,
  ParsedBlueprintContractBlock
} from "./types.js"
import { normalizeBasename, normalizeSpecPath, uniqueStrings } from "./normalize.js"

const BLUEPRINT_CONTRACT_BLOCK_RE = /```blueprint-contract\s*([\s\S]*?)```/iu

function normalizeFunctionSpec(input: unknown): BlueprintFunctionSpec | null {
  const normalizeParameter = (parameter: unknown): string | null => {
    if (typeof parameter === "string") {
      const normalized = parameter.trim()
      return normalized || null
    }
    if (!parameter || typeof parameter !== "object") return null
    const rawParameter = parameter as Record<string, unknown>
    const name = typeof rawParameter.name === "string" ? rawParameter.name.trim() : ""
    const type =
      typeof rawParameter.type === "string"
        ? rawParameter.type.trim()
        : typeof rawParameter.schema === "string"
          ? rawParameter.schema.trim()
          : ""
    if (!name && !type) return null
    if (!name) return type || null
    return type ? `${name}: ${type}` : name
  }

  const buildSignature = (name: string, raw: Record<string, unknown>): string => {
    const providedSignature = typeof raw.signature === "string" ? raw.signature.trim() : ""
    if (providedSignature) return providedSignature

    const rawParameters = Array.isArray(raw.parameters)
      ? raw.parameters
      : Array.isArray(raw.params)
        ? raw.params
        : Array.isArray(raw.arguments)
          ? raw.arguments
          : []
    const parameters = rawParameters
      .map(normalizeParameter)
      .filter((value): value is string => Boolean(value))
    const returnType =
      typeof raw.returnType === "string"
        ? raw.returnType.trim()
        : typeof raw.returns === "string"
          ? raw.returns.trim()
          : ""
    const parameterBlock = parameters.join(", ")
    return returnType ? `${name}(${parameterBlock}): ${returnType}` : `${name}(${parameterBlock})`
  }

  if (typeof input === "string") {
    const name = input.trim()
    if (!name) return null
    return {
      name,
      signature: `${name}()`
    }
  }
  if (!input || typeof input !== "object") return null
  const raw = input as Record<string, unknown>
  const name = typeof raw.name === "string" ? raw.name.trim() : ""
  if (!name) return null
  return {
    name,
    signature: buildSignature(name, raw)
  }
}

function normalizeSharedTypeSpec(input: unknown): BlueprintSharedTypeSpec | null {
  const normalizeDefinition = (raw: Record<string, unknown>): string => {
    if (typeof raw.definition === "string" && raw.definition.trim()) return raw.definition.trim()
    if (typeof raw.shape === "string" && raw.shape.trim()) return raw.shape.trim()
    if (Array.isArray(raw.properties) && raw.properties.length > 0) {
      const propertyPairs = raw.properties.flatMap((property) => {
        if (!property || typeof property !== "object") return []
        const rawProperty = property as Record<string, unknown>
        const name = typeof rawProperty.name === "string" ? rawProperty.name.trim() : ""
        const type = typeof rawProperty.type === "string" ? rawProperty.type.trim() : "unknown"
        return name ? [`${name}: ${type}`] : []
      })
      if (propertyPairs.length > 0) return `{ ${propertyPairs.join("; ")} }`
    }
    if (typeof raw.type === "string" && raw.type.trim()) return raw.type.trim()
    if (raw.schema && typeof raw.schema === "object") {
      try {
        return JSON.stringify(raw.schema)
      } catch {
        return ""
      }
    }
    return ""
  }

  if (typeof input === "string") {
    const name = input.trim()
    if (!name) return null
    return {
      name,
      definition: "",
      usedBy: []
    }
  }
  if (!input || typeof input !== "object") return null
  const raw = input as Record<string, unknown>
  const name = typeof raw.name === "string" ? raw.name.trim() : ""
  const definition = normalizeDefinition(raw)
  if (!name) return null
  return {
    name,
    definition,
    usedBy: normalizeMarkerList(raw.usedBy ?? raw.used_by ?? raw.consumers ?? raw.paths)
  }
}

function normalizeMarkerList(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  return uniqueStrings(input.filter((value): value is string => typeof value === "string"))
}

function normalizeFileSpec(input: unknown): BlueprintFileSpec | null {
  if (!input || typeof input !== "object") return null
  const raw = input as Record<string, unknown>
  const declaredPath =
    typeof raw.path === "string"
      ? normalizeSpecPath(raw.path)
      : typeof raw.declaredPath === "string"
        ? normalizeSpecPath(raw.declaredPath)
        : ""
  if (!declaredPath) return null
  const rawFunctions = Array.isArray(raw.functions)
    ? raw.functions
    : Array.isArray(raw.exports)
      ? raw.exports
      : Array.isArray(raw.exportedFunctions)
        ? raw.exportedFunctions
        : null
  if (!rawFunctions) return null
  const functions = rawFunctions
    .map(normalizeFunctionSpec)
    .filter((value): value is BlueprintFunctionSpec => Boolean(value))
  if (functions.length !== rawFunctions.length) return null
  return {
    declaredPath,
    basename: normalizeBasename(declaredPath),
    functions,
    structuralMarkers: normalizeMarkerList(raw.structuralMarkers)
  }
}

export function parseBlueprintContractBlock(content: string): ParsedBlueprintContractBlock {
  const match = content.match(BLUEPRINT_CONTRACT_BLOCK_RE)
  if (!match) {
    return { present: false, files: [], sharedTypes: [], errors: [] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(match[1].trim())
  } catch (error) {
    return {
      present: true,
      files: [],
      sharedTypes: [],
      errors: [
        `BLUEPRINT CONTRACT INVALID: machine-readable blueprint-contract block is not valid JSON (${error instanceof Error ? error.message : String(error)})`
      ]
    }
  }

  if (!parsed || typeof parsed !== "object") {
    return {
      present: true,
      files: [],
      sharedTypes: [],
      errors: ["BLUEPRINT CONTRACT INVALID: blueprint-contract block must be a JSON object"]
    }
  }

  const raw = parsed as Record<string, unknown>
  const version = raw.version
  if (version !== 1) {
    return {
      present: true,
      files: [],
      sharedTypes: [],
      errors: ['BLUEPRINT CONTRACT INVALID: blueprint-contract block must declare "version": 1']
    }
  }

  if (!Array.isArray(raw.files)) {
    return {
      present: true,
      files: [],
      sharedTypes: [],
      errors: ['BLUEPRINT CONTRACT INVALID: blueprint-contract block must declare a "files" array']
    }
  }

  if (!Array.isArray(raw.sharedTypes)) {
    return {
      present: true,
      files: [],
      sharedTypes: [],
      errors: [
        'BLUEPRINT CONTRACT INVALID: blueprint-contract block must declare a "sharedTypes" array (use [] when none are shared)'
      ]
    }
  }

  const files = raw.files.map(normalizeFileSpec).filter((value): value is BlueprintFileSpec => Boolean(value))
  if (files.length !== raw.files.length) {
    return {
      present: true,
      files: [],
      sharedTypes: [],
      errors: [
        'BLUEPRINT CONTRACT INVALID: every blueprint-contract file entry must declare a non-empty exact path and a "functions" array (use [] when the file exports no functions)'
      ]
    }
  }

  const sharedTypes = raw.sharedTypes
    .map(normalizeSharedTypeSpec)
    .filter((value): value is BlueprintSharedTypeSpec => Boolean(value))
  if (sharedTypes.length !== raw.sharedTypes.length) {
    return {
      present: true,
      files: [],
      sharedTypes: [],
      errors: ["BLUEPRINT CONTRACT INVALID: every sharedTypes entry must declare a non-empty name"]
    }
  }

  const normalizedPaths = files.map((file) => file.declaredPath)
  if (new Set(normalizedPaths).size !== normalizedPaths.length) {
    return {
      present: true,
      files: [],
      sharedTypes: [],
      errors: ["BLUEPRINT CONTRACT INVALID: blueprint-contract file paths must be unique"]
    }
  }

  const normalizedSharedTypeNames = sharedTypes.map((type) => type.name.toLowerCase())
  if (new Set(normalizedSharedTypeNames).size !== normalizedSharedTypeNames.length) {
    return {
      present: true,
      files: [],
      sharedTypes: [],
      errors: ["BLUEPRINT CONTRACT INVALID: sharedTypes names must be unique"]
    }
  }

  return { present: true, files, sharedTypes, errors: [] }
}
