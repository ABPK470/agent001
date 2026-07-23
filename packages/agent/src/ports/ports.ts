import type { MssqlConfig, MssqlConnectionPool } from "../internal/mssql-types.js"
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
  config: MssqlConfig
  pool: MssqlConnectionPool | null
  knowledge: string | null
}

// ── Live connector-keyed MSSQL pool provider ──────────────────────
//
// The single source of truth for MSSQL database connections: connectors
// persisted in SQLite, read live. Both sync environments (via their
// `connectorId` FK) and the agent's direct MSSQL tools/catalog (by connector
// name) resolve pools through this provider. There is no boot-time name-keyed
// map and no name-matching fallback.

export interface MssqlConnectorPool {
  connectorId: string
  pool: MssqlConnectionPool
  config: MssqlConfig
  knowledge: string | null
}

export interface MssqlPoolProvider {
  /** Resolve a pool by connector id (primary key). */
  get(connectorId: string): Promise<MssqlConnectorPool>
  /** Resolve a pool by connector name (case-insensitive). */
  getByName(name: string): Promise<MssqlConnectorPool>
  /** Read a connector's finalized `sql.config` without connecting (for pool gating). */
  configOf(connectorId: string): MssqlConfig | undefined
  /** Enabled mssql connectors (live read). */
  list(): readonly { id: string; name: string }[]
  /** Drop the cached pool for a connector (e.g. after config change). */
  invalidate(connectorId: string): void
}

// ── Sync ports (recipe reader; sinks live in sync/ for now) ──────

export interface RecipeReader {
  resolve(args: { type: string; environment?: string }): {
    recipeName: string
    bundlePath: string
  } | null
}
