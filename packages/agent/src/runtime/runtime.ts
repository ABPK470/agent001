/**
 * Stateful-shell entrypoint for host/runtime configuration.
 */

export { configureAgent, makeRunContext } from "./runtime-cluster/index.js"
export type {
  ConfigureAgentOptions,
  ConfigureAgentSyncOptions,
  ConfigureMssqlConnection,
  MakeRunContextOptions
} from "./runtime-cluster/index.js"

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
} from "./runtime-cluster/index.js"

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
} from "./runtime-cluster/index.js"
