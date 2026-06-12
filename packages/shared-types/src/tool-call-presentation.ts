/**
 * Tool-call presentation — single source of truth for trace / UI display.
 *
 * Runtime-injected args (e.g. planner trace context) are stripped before
 * persistence or rendering. Human-readable `formatted` text and collapsed
 * `summary` strings are derived from a declarative registry, not ad-hoc
 * switches in the UI.
 */

/** Injected at execute time by the agent loop — not part of the LLM contract. */
export const TOOL_TRACE_ARG = "__plannerTrace" as const

const RUNTIME_TOOL_ARG_KEYS = new Set<string>([TOOL_TRACE_ARG])

export interface ToolPresentationSpec {
  /** Primary code body (SQL, shell, file content). */
  artifactField?: string
  artifactLang?: string | "auto"
  /** Used with artifactLang "auto" to guess syntax from extension. */
  pathField?: string
  /** Preferred key order for structured multi-line display. */
  fieldOrder?: readonly string[]
  /** When only one of these string fields is set, show its value alone. */
  scalarFields?: readonly string[]
  /** Preferred field for collapsed pill / row preview. */
  summaryField?: string
}

/**
 * Declarative presentation hints keyed by tool name.
 * Add entries here when a tool needs ordering or artifact semantics —
 * never branch on tool names in UI components.
 */
export const TOOL_PRESENTATION: Readonly<Record<string, ToolPresentationSpec>> = {
  query_mssql: { artifactField: "query", artifactLang: "sql", summaryField: "query" },
  export_query_to_file: { artifactField: "query", artifactLang: "sql", summaryField: "query" },
  run_command: { artifactField: "command", artifactLang: "sh", summaryField: "command" },
  write_file: {
    artifactField: "content",
    artifactLang: "auto",
    pathField: "path",
    scalarFields: ["path", "filePath", "file"],
    summaryField: "path"
  },
  append_file: {
    artifactField: "content",
    artifactLang: "auto",
    pathField: "path",
    scalarFields: ["path", "filePath", "file"],
    summaryField: "path"
  },
  replace_in_file: {
    artifactField: "new_content",
    artifactLang: "auto",
    pathField: "path",
    scalarFields: ["path", "filePath", "file"],
    summaryField: "path"
  },
  read_file: { scalarFields: ["path", "filePath", "file"], summaryField: "path" },
  list_directory: { scalarFields: ["path", "filePath", "file"], summaryField: "path" },
  fetch_url: { scalarFields: ["url", "href"], summaryField: "url" },
  browse_web: { scalarFields: ["url", "href"], summaryField: "url" },
  search_catalog: {
    fieldOrder: [
      "search",
      "schema",
      "table",
      "column",
      "joins",
      "path",
      "sys",
      "stats",
      "refresh",
      "connection"
    ],
    summaryField: "search"
  },
  search_files: {
    fieldOrder: ["pattern", "path", "include", "regex"],
    summaryField: "pattern"
  },
  inspect_definition: { summaryField: "name", scalarFields: ["name", "objectName"] },
  explore_mssql_schema: { summaryField: "table", scalarFields: ["table", "schema"] },
  sync_preview: {
    fieldOrder: ["planId", "confirm", "entityType", "entityId"],
    summaryField: "planId"
  },
  sync_execute: {
    fieldOrder: ["planId", "confirm", "entityType", "entityId"],
    summaryField: "planId"
  }
}

export interface ToolCallArtifact {
  code: string
  lang: string
  field: string
}

export interface ToolCallPresentation {
  summary: string
  /** Human-readable expanded input — derive at read time; do not persist over JSON args. */
  display: string
  /** LLM args with runtime-only keys removed. */
  cleanArgs: Record<string, unknown>
  artifact: ToolCallArtifact | null
}

/** Persisted wire form: clean JSON args (no runtime injection keys). */
export function serializeToolCallArgs(args: Record<string, unknown>): string {
  return JSON.stringify(stripRuntimeToolArgs(args), null, 2)
}

export function stripRuntimeToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (RUNTIME_TOOL_ARG_KEYS.has(key)) continue
    out[key] = value
  }
  return out
}

function formatArgLine(key: string, value: unknown): string {
  if (typeof value === "string") return `${key}: ${value}`
  if (typeof value === "boolean") return value ? key : `${key}: false`
  if (typeof value === "number") return `${key}: ${value}`
  if (value === null || value === undefined) return `${key}: ${String(value)}`
  if (Array.isArray(value)) return `${key}: ${JSON.stringify(value)}`
  return `${key}: ${JSON.stringify(value)}`
}

function guessLangFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  const MAP: Record<string, string> = {
    ts: "ts",
    tsx: "ts",
    js: "js",
    jsx: "js",
    mjs: "js",
    sql: "sql",
    py: "python",
    sh: "sh",
    bash: "sh",
    zsh: "sh",
    json: "json",
    html: "html",
    css: "css",
    scss: "scss",
    md: "markdown"
  }
  return MAP[ext] ?? "text"
}

function orderedKeys(args: Record<string, unknown>, spec?: ToolPresentationSpec): string[] {
  const seen = new Set<string>()
  const keys: string[] = []
  for (const key of spec?.fieldOrder ?? []) {
    if (key in args) {
      keys.push(key)
      seen.add(key)
    }
  }
  for (const key of Object.keys(args)) {
    if (!seen.has(key)) keys.push(key)
  }
  return keys
}

function formatStructuredArgs(args: Record<string, unknown>, spec?: ToolPresentationSpec): string {
  const lines: string[] = []
  for (const key of orderedKeys(args, spec)) {
    const value = args[key]
    if (value === undefined || value === null) continue
    if (typeof value === "boolean" && value === true && spec?.fieldOrder) {
      lines.push(key)
      continue
    }
    lines.push(formatArgLine(key, value))
  }
  return lines.join("\n")
}

function extractArtifact(
  toolName: string,
  args: Record<string, unknown>
): ToolCallArtifact | null {
  const spec = TOOL_PRESENTATION[toolName]
  if (!spec?.artifactField) return null
  const code = args[spec.artifactField]
  if (typeof code !== "string" || !code.trim()) return null
  const lang =
    spec.artifactLang === "auto"
      ? guessLangFromPath(String(args[spec.pathField ?? "path"] ?? ""))
      : (spec.artifactLang ?? "text")
  return { code, lang, field: spec.artifactField }
}

function scalarOnlyValue(args: Record<string, unknown>, spec?: ToolPresentationSpec): string | null {
  const scalarFields = spec?.scalarFields
  if (!scalarFields) return null
  const keys = Object.keys(args)
  if (keys.length !== 1) return null
  const onlyKey = keys[0]!
  if (!scalarFields.includes(onlyKey)) return null
  const value = args[onlyKey]
  return typeof value === "string" ? value : null
}

function buildSummary(toolName: string, args: Record<string, unknown>): string {
  const spec = TOOL_PRESENTATION[toolName]
  const keys = Object.keys(args)
  if (keys.length === 0) return ""

  if (spec?.summaryField && spec.summaryField in args) {
    const value = args[spec.summaryField]
    if (value !== undefined && value !== null) {
      return `${spec.summaryField}=${JSON.stringify(value)}`
    }
  }

  if (keys.length === 1) {
    const key = keys[0]!
    return `${key}=${JSON.stringify(args[key])}`
  }
  return `${keys.length} args`
}

function buildFormatted(toolName: string, args: Record<string, unknown>): string {
  const spec = TOOL_PRESENTATION[toolName]
  const artifact = extractArtifact(toolName, args)
  if (artifact) return artifact.code

  const scalar = scalarOnlyValue(args, spec)
  if (scalar !== null) return scalar

  const entries = Object.entries(args)
  if (entries.length === 1 && !spec?.fieldOrder) {
    const [key, value] = entries[0]!
    if (typeof value === "string") return value
    return formatArgLine(key, value)
  }

  const structured = formatStructuredArgs(args, spec)
  if (structured) return structured
  return JSON.stringify(args, null, 2)
}

/** Build summary + formatted display for a tool invocation. */
export function presentToolCall(
  toolName: string,
  args: Record<string, unknown>
): ToolCallPresentation {
  const clean = stripRuntimeToolArgs(args)
  return {
    summary: buildSummary(toolName, clean),
    display: buildFormatted(toolName, clean),
    cleanArgs: clean,
    artifact: extractArtifact(toolName, clean)
  }
}

/** Parse persisted `argsFormatted` JSON and present it. */
export function presentToolCallFromFormatted(
  toolName: string,
  argsFormatted: string
): ToolCallPresentation {
  try {
    const parsed = JSON.parse(argsFormatted) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { summary: "", display: argsFormatted, cleanArgs: {}, artifact: null }
    }
    return presentToolCall(toolName, parsed as Record<string, unknown>)
  } catch {
    return { summary: "", display: argsFormatted, cleanArgs: {}, artifact: null }
  }
}

/** Short preview for timeline rows (path basename, search term, etc.). */
export function toolCallPreview(toolName: string, args: Record<string, unknown>): string | null {
  const clean = stripRuntimeToolArgs(args)
  const spec = TOOL_PRESENTATION[toolName]

  for (const key of orderedKeys(clean, spec)) {
    const value = clean[key]
    if (value === true) return key
    if (typeof value === "string" && value.trim()) {
      const base = value.split("/").pop() ?? value
      return base.length > 80 ? `${base.slice(0, 77)}…` : base
    }
    if (key === "path" && Array.isArray(value) && value.length >= 2) {
      return `${String(value[0])} → ${String(value[1])}`
    }
  }
  return null
}

/** One-line detail for compact tool rows (AgentChat, etc.). */
export function toolCallDetailPreview(
  toolName: string,
  args: Record<string, unknown>,
  maxLen = 120
): string | null {
  const clean = stripRuntimeToolArgs(args)
  const artifact = extractArtifact(toolName, clean)
  if (artifact) {
    const collapsed = artifact.code.replace(/\s+/g, " ").trim()
    return collapsed.length > maxLen ? `${collapsed.slice(0, maxLen)}…` : collapsed
  }

  const preview = toolCallPreview(toolName, clean)
  if (preview) return preview.length > maxLen ? `${preview.slice(0, maxLen)}…` : preview

  for (const value of Object.values(clean)) {
    if (typeof value === "string" && value.trim()) {
      return value.length > maxLen ? `${value.slice(0, maxLen)}…` : value
    }
  }
  return null
}
