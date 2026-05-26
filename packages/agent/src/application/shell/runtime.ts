/**
 * Stateful-shell entrypoint for host/runtime configuration.
 */

export { configureAgent, makeRunContext } from "../../host/index.js"
export type { ConfigureAgentOptions, ConfigureMssqlConnection, MakeRunContextOptions } from "../../host/index.js"

export type {
    AgentHost,
    BrowserCheckHost,
    BrowserHost,
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
} from "../../host/index.js"

export type {
    AttachmentMetadata,
    AttachmentStore,
    BrowserCheckRunResult,
    BrowserClient,
    BrowserContextHandle,
    BrowserContextReader,
    BrowserGuard,
    CredentialReader,
    HandoffStore,
    MssqlEntry,
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
} from "../../host/index.js"
