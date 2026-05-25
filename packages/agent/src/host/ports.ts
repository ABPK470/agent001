/**
 * host/ports.ts — port interfaces under doctrine §4 naming.
 *
 * These are the **named contracts** between the agent core and the world.
 * The host (composition root) wires concrete adapters into these slots
 * at boot; the agent calls them as plain parameters. Nothing in this file
 * imports an implementation.
 *
 * Naming follows the four canonical suffixes — see docs/doctrine.md §4.
 * The Phase 2 design re-states each port using the new name. During Phase
 * 4 each old name (BrowserContextProvider, ShellExecutor, …) is replaced
 * by its corresponding new port here; the old types stay for one phase
 * as structural aliases so calls keep compiling.
 *
 * RENAME MAP (old → new):
 *   BrowserContextProvider     → BrowserContextReader
 *   BrowserCredentialProvider  → CredentialReader
 *   BrowserHandoffProvider     → HandoffStore
 *   AttachmentService          → AttachmentStore
 *   AskUserResolver            → UserInputReader
 *   ShellExecutor              → ShellClient
 *   BrowserCheckExecutor       → BrowserClient
 *   RecipeResolver             → RecipeReader
 */

import type sql from "mssql"
import type { HumanHandoffReason, UserInputStatus } from "../domain/enums/agent-runtime.js"
import type { AttachmentScope } from "../domain/enums/attachment.js"
import type { IngestionMode } from "../domain/enums/runtime.js"

// ── Generic shell / browser-check execution clients ──────────────

/** Result of running one shell command in the sandbox. */
export interface ShellExecResult {
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
}

/**
 * The agent's only door to the OS shell. The host wires this once at
 * boot (Docker sandbox, local subprocess, mock). Per-call abort flows
 * via `RunContext.signal`, not through this port.
 */
export interface ShellClient {
  exec(command: string, cwd: string, signal?: AbortSignal): Promise<ShellExecResult>
}

/**
 * The agent's only door to running browser-check (visual diff / linkrot)
 * jobs. Concrete adapter lives in the server package.
 */
export interface BrowserClient {
  run(args: {
    cwd: string
    targetPath: string
    signal?: AbortSignal
  }): Promise<{ ok: boolean; report: string }>
}

// ── Browser context / credential / handoff ───────────────────────

/** Handle returned by the persistent-context reader; passed to Playwright. */
export interface BrowserContextHandle {
  /** Stable seed for fingerprint selection (typically the upn). */
  fingerprintSeed: string
  /** Pass directly to Playwright `browser.newContext({ storageState })`. */
  storageState: unknown | null
}

/**
 * Persistent-context reader. Returns null for anonymous sessions or when
 * the host has no persistence backend wired (CLI / tests → ephemeral).
 */
export interface BrowserContextReader {
  acquire(): Promise<BrowserContextHandle | null>
}

/** Read user-scoped credentials for browser auto-login. */
export interface CredentialReader {
  resolvePassword(id: string): Promise<{
    label: string
    targetOrigin: string
    username: string
    password: string
  } | null>
  resolveTotp(id: string): Promise<{
    label: string
    targetOrigin: string
    code: string
  } | null>
}

/**
 * Open a live-VNC handoff so the user can complete a CAPTCHA / non-TOTP
 * 2FA challenge inside the sandbox session. `request()` writes a new
 * handoff record; `await()` reads its resolution. Returns null for
 * anonymous sessions or when no backend is wired.
 */
export interface HandoffStore {
  request(input: {
    browserSessionId: string
    reason: HumanHandoffReason
    ttlMs?: number
  }): Promise<{ id: string; url: string; expiresAt: number } | null>
  await(id: string): Promise<{ status: UserInputStatus }>
}

// ── Ask-user (UI prompt channel) ─────────────────────────────────

/**
 * Resolve a clarifying question with the user via the host UI channel.
 * Returns the user's response as a string. Implementations block until
 * the user actually responds (the orchestrator handles WS broadcast,
 * timeout, masking of sensitive answers).
 *
 * Shape mirrors the legacy `AskUserResolver` exactly so Phase 4
 * migration is purely a rename.
 */
export type UserInputReader = (
  question: string,
  options?: string[],
  sensitive?: boolean,
) => Promise<string>

// ── Attachments ──────────────────────────────────────────────────

export interface AttachmentMetadata {
  id:             string
  scope:          AttachmentScope
  originalName:   string
  normalizedName: string
  mediaType:      string
  sizeBytes:      number
  contentHash:    string
  ingestionMode:  IngestionMode
  uploadedAt:     string
  purposeTag:     string | null
}

/**
 * Durable user-attachment backend (read + sandbox import + promote). The
 * server installs a concrete implementation at boot; CLI / tests get null
 * and tools surface a friendly "attachments are not configured" error.
 */
export interface AttachmentStore {
  list(filter?: {
    runId?: string
    scope?: AttachmentMetadata["scope"]
    q?: string
  }): Promise<AttachmentMetadata[]>
  get(id: string): Promise<AttachmentMetadata | null>
  read(id: string, opts?: { maxBytes?: number; offset?: number }): Promise<{
    kind: "text" | "binary"
    text?: string
    bytes?: Uint8Array
    truncated: boolean
    sizeBytes: number
    offset: number
    nextOffset: number | null
  }>
  importToSandbox(id: string, sandboxRelPath: string): Promise<{
    sandboxPath: string
    sizeBytes: number
  }>
  promoteFromSandbox(sandboxRelPath: string, opts?: {
    mediaType?: string
    purposeTag?: string | null
  }): Promise<AttachmentMetadata>
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

/**
 * Read/write cache for heavy MSSQL tool outputs. Owned by the host; the
 * server's concrete adapter persists to the semantic-memory tier.
 */
export interface ToolKnowledgeStore {
  lookup(args: ToolKnowledgeLookupArgs): ToolKnowledgeHit | ToolKnowledgeMiss
  save(args: ToolKnowledgeSaveArgs): void
  renderHeader(hit: ToolKnowledgeHit, opts: {
    tool: ToolKnowledgeCachedTool
    mode?: string
  }): string
}

// ── Table verdicts (read-only durable role classifications) ──────

export type TableVerdictRoleType =
  | "canonical" | "subset" | "staging" | "archive" | "rules" | "unknown"

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

/** Read-only resolver for which recipe applies to a given entity type. */
export interface RecipeReader {
  resolve(args: { type: string; environment?: string }): {
    recipeName: string
    bundlePath: string
  } | null
}
