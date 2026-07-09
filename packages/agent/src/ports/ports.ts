import type sql from "mssql"
import type { AttachmentScope } from "../domain/enums/attachment.js"
import type { IngestionMode } from "../domain/enums/runtime.js"

// ── Generic shell execution client ────────────────────────────────

export interface ShellExecResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  sandboxed: boolean
}

export type ShellClient = (command: string, cwd: string, signal?: AbortSignal) => Promise<ShellExecResult>

// ── Ask-user (UI prompt channel) ─────────────────────────────────

export type UserInputReader = (question: string, options?: string[], sensitive?: boolean) => Promise<string>

// ── Attachments ──────────────────────────────────────────────────

export interface AttachmentMetadata {
  id: string
  scope: AttachmentScope
  originalName: string
  normalizedName: string
  mediaType: string
  sizeBytes: number
  contentHash: string
  ingestionMode: IngestionMode
  uploadedAt: string
  purposeTag: string | null
}

export interface AttachmentStore {
  list(filter?: {
    runId?: string
    scope?: AttachmentMetadata["scope"]
    q?: string
  }): Promise<AttachmentMetadata[]>
  get(id: string): Promise<AttachmentMetadata | null>
  read(
    id: string,
    opts?: { maxBytes?: number; offset?: number }
  ): Promise<{
    kind: "text" | "binary"
    text?: string
    bytes?: Uint8Array
    truncated: boolean
    sizeBytes: number
    offset: number
    nextOffset: number | null
  }>
  importToSandbox(
    id: string,
    sandboxRelPath: string
  ): Promise<{
    sandboxPath: string
    sizeBytes: number
  }>
  promoteFromSandbox(
    sandboxRelPath: string,
    opts?: {
      mediaType?: string
      purposeTag?: string | null
    }
  ): Promise<AttachmentMetadata>
}

// ── Tool-knowledge cache (semantic memo for heavy MSSQL tools) ───

export type ToolKnowledgeCachedTool =
  | "profile_data"
  | "inspect_definition"
  | "discover_relationships"
  | "explore_mssql_schema"

export interface ToolKnowledgeFingerprint {
  cols: number
  type: "T" | "V"
  csum: string
}

export interface ToolKnowledgeHit {
  hit: true
  payload: string
  ageMs: number
  profiledAt: number
}

export interface ToolKnowledgeMiss {
  hit: false
  reason: "miss" | "stale" | "fingerprint"
}

export interface ToolKnowledgeLookupArgs {
  tool: ToolKnowledgeCachedTool
  qname: string
  mode?: string
  connection?: string
  currentFingerprint: ToolKnowledgeFingerprint | null
}

export interface ToolKnowledgeSaveArgs {
  tool: ToolKnowledgeCachedTool
  qname: string
  mode?: string
  connection?: string
  payload: string
  fingerprint: ToolKnowledgeFingerprint
}

export interface ToolKnowledgeStore {
  lookup(args: ToolKnowledgeLookupArgs): ToolKnowledgeHit | ToolKnowledgeMiss
  save(args: ToolKnowledgeSaveArgs): void
  renderHeader(
    hit: ToolKnowledgeHit,
    opts: {
      qname: string
      tool: ToolKnowledgeCachedTool
      mode?: string
    }
  ): string
}

// ── Table verdicts (read-only durable role classifications) ──────

export type TableVerdictRoleType = "canonical" | "subset" | "staging" | "archive" | "rules" | "unknown"

export interface TableVerdictRecord {
  qname: string
  role: TableVerdictRoleType
  evidence: string[]
  confidence: number
  createdAt: string
}

export interface TableVerdictsReader {
  list(args: { qnames: string[]; connection?: string }): TableVerdictRecord[]
}

// ── MSSQL connection registry (host-wired) ───────────────────────

export interface MssqlEntry {
  config: sql.config
  pool: sql.ConnectionPool | null
  writeEnabled: boolean
  knowledge: string | null
}

// ── Sync ports (recipe reader; sinks live in sync/ for now) ──────

export interface RecipeReader {
  resolve(args: { type: string; environment?: string }): {
    recipeName: string
    bundlePath: string
  } | null
}
