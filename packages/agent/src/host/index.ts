/**
 * host/index.ts — public door for the host cluster.
 *
 * Outside callers (server entrypoint, CLI, tests, future tool migrations)
 * import only from `@mia/agent/host` — never from `./ports.js` or
 * `./host.js` directly. See docs/doctrine.md §7 for the cluster-door
 * rule.
 *
 * Phase 2 surface — additive. No existing code references this yet.
 */

export { configureAgent } from "./configure.js"
export type { ConfigureAgentOptions } from "./configure.js"
export { makeRunContext } from "./run-context.js"
export type { MakeRunContextOptions } from "./run-context.js"

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
} from "./host.js"

export type {
    AttachmentMetadata,
    AttachmentStore,
    BrowserCheckRunResult,
    BrowserClient,
    BrowserContextHandle,
    BrowserContextReader,
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
} from "./ports.js"

