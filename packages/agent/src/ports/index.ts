/**
 * Contract door for the new `ports/` cluster.
 *
 * This is an additive compatibility barrel. Existing implementations still
 * live under `host/ports.ts`; new imports can start depending on `ports/`
 * immediately while the physical migration remains incremental.
 */

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
} from "../host/ports.js"
