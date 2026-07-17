/**
 * host/index.ts — public door for the host cluster.
 *
 * Outside callers (server entrypoint, CLI, tests, future tool migrations)
 * import only from `@mia/agent` — never from these runtime-cluster files
 * directly. See docs/doctrine.md §7 for the cluster-door rule.
 *
 * Canonical runtime-cluster surface for host construction helpers.
 */

export { configureAgent } from "./configure.js"
export type {
  ConfigureAgentOptions,
  ConfigureAgentSyncOptions,
  ConfigureMssqlConnection
} from "./configure.js"
export { makeRunContext } from "./run-context.js"
export type { MakeRunContextOptions } from "./run-context.js"

export type {
  AgentHost,
  CatalogHost,
  FilesystemHost,
  MssqlHost,
  PolicyContext,
  RunContext,
  RunMemoryWriter,
  SearchFilesHost,
  ShellHost,
  SyncHost,
  SyncOpContext,
  TenantHost,
  ToolTraceContext
} from "./host.js"

export type {
  AttachmentMetadata,
  AttachmentStore,
  MssqlConnectorPool,
  MssqlEntry,
  MssqlPoolProvider,
  RecipeReader,
  ShellClient,
  ShellExecResult,
  TableVerdictRecord,
  TableVerdictRoleType,
  TableVerdictsReader,
  ToolKnowledgeCachedTool,
  ToolKnowledgeFingerprint,
  ToolKnowledgeHit,
  ToolKnowledgeLookupArgs,
  ToolKnowledgeMiss,
  ToolKnowledgeSaveArgs,
  ToolKnowledgeStore,
  UserInputReader
} from "../../ports/ports.js"
