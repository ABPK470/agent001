/**
 * Ports — outside-world contracts and port-backed services.
 *
 * What: host/store/client shapes + AuditService / Learner / memory adapters.
 * Why: I/O and repository-backed services stay at the edge.
 * Next: server implements host ports; createEngineServices wires in-memory adapters.
 */

export type {
  AttachmentMetadata,
  AttachmentStore,
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

export * from "./services/index.js"
