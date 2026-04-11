/**
 * Shared frontend types — mirrors the server API contract.
 */

// ── Run ──────────────────────────────────────────────────────────

export interface Run {
  id: string
  goal: string
  status: string
  answer: string | null
  stepCount: number
  error: string | null
  parentRunId: string | null
  agentId: string | null
  createdAt: string
  completedAt: string | null
  totalTokens: number
  promptTokens: number
  completionTokens: number
  llmCalls: number
  pendingWorkspaceChanges?: number
}

export interface RunDetail extends Run {
  data: {
    steps: Step[]
    [key: string]: unknown
  }
  audit: AuditEntry[]
  logs: LogEntry[]
  hasCheckpoint: boolean
}

export interface WorkspaceDiff {
  runId: string
  added: string[]
  modified: string[]
  deleted: string[]
  total: number
}

export interface WorkspaceDiffApplyResult {
  ok: boolean
  runId: string
  applied: {
    added: number
    modified: number
    deleted: number
  }
}

// ── Step ─────────────────────────────────────────────────────────

export interface Step {
  id: string
  name: string
  action: string
  status: string
  order: number
  input: Record<string, unknown>
  output: Record<string, unknown>
  error: string | null
  startedAt: string | null
  completedAt: string | null
}

// ── Audit ────────────────────────────────────────────────────────

export interface AuditEntry {
  actor: string
  action: string
  detail: Record<string, unknown>
  timestamp: string
}

// ── Log ──────────────────────────────────────────────────────────

export interface LogEntry {
  level: string
  message: string
  timestamp: string
}

// ── Trace (rich agent execution trace) ───────────────────────────

export type TraceEntry =
  | { kind: "goal"; text: string }
  | { kind: "iteration"; current: number; max: number }
  | { kind: "thinking"; text: string }
  | { kind: "tool-call"; tool: string; argsSummary: string; argsFormatted: string }
  | { kind: "tool-result"; text: string }
  | { kind: "tool-error"; text: string }
  | { kind: "answer"; text: string }
  | { kind: "error"; text: string }
  | { kind: "usage"; iterationTokens: number; totalTokens: number; promptTokens: number; completionTokens: number; llmCalls: number }
  | { kind: "delegation-start"; goal: string; depth: number; tools: string[]; agentId?: string; agentName?: string }
  | { kind: "delegation-iteration"; depth: number; iteration: number; maxIterations: number }
  | { kind: "delegation-end"; depth: number; status: "done" | "error"; answer?: string; error?: string }
  | { kind: "delegation-parallel-start"; depth: number; taskCount: number; goals: string[] }
  | { kind: "delegation-parallel-end"; depth: number; taskCount: number; fulfilled: number; rejected: number }
  | { kind: "user-input-request"; question: string; options?: string[]; sensitive?: boolean }
  | { kind: "user-input-response"; text: string }
  // Planner entries (agenc-core planner-first routing)
  | { kind: "planning_preflight"; mode: "planner-first" }
  | { kind: "planner-decision"; score: number; shouldPlan: boolean; reason: string }
  | { kind: "planner-generating" }
  | { kind: "planner-plan-generated"; reason: string; stepCount: number; steps: Array<{ name: string; type: string; dependsOn?: string[] }>; edges?: Array<{ from: string; to: string }> }
  | {
    kind: "planner-runtime-compiled"
    executionSteps: Array<{ stepName: string; dependsOn: string[]; downstream: string[] }>
    ownershipArtifacts: Array<{ artifactPath: string; ownerStepName: string | null; consumerStepNames: string[] }>
    runtimeEntities: Array<{ id: string; entityType: string; parentId?: string; stepName?: string }>
  }
  | { kind: "planner-generation-failed"; diagnostics: Array<{ code: string; message: string }> }
  | { kind: "planner-output-root-forced"; outputRoot: string }
  | { kind: "planner-validation-failed"; diagnostics: Array<{ code: string; message: string }> }
  | { kind: "planner-validation-remediated"; diagnostics: Array<{ code: string; message: string }> }
  | { kind: "planner-validation-warnings"; warningCount: number; diagnostics: Array<{ code: string; message: string }> }
  | { kind: "direct_loop_fallback"; source: "planner_declined" | "planner_verifier_low_complexity"; reason: string }
  | { kind: "planner-pipeline-start"; attempt: number; verifierRound?: number; maxRetries: number }
  | { kind: "planner-pipeline-end"; status: string; completedSteps: number; totalSteps: number }
  | { kind: "planner-step-start"; stepName: string; stepType: string }
  | { kind: "planner-step-transition"; attempt: number; stepName: string; phase: "execution" | "verification" | "repair"; state: string; timestamp: number }
  | {
    kind: "planner-step-end"
    stepName: string
    status: string
    executionState?: string
    acceptanceState?: string
    durationMs: number
    error?: string
    validationCode?: string
    producedArtifacts?: string[]
    verificationAttempts?: Array<{ toolName: string; target?: string; success: boolean; summary: string }>
    reconciliation?: { compliant: boolean; findings: Array<{ code: string; severity: string; message: string }> }
  }
  | {
    kind: "planner-verification"
    overall: string
    confidence: number
    verifierRound?: number
    systemChecks?: Array<{ code: string; severity: string; summary: string; confidence: number }>
    steps: Array<{ stepName: string; outcome: string; issues: string[]; issueCodes?: string[]; acceptanceState?: string; ownershipModes?: string[]; issueConfidences?: number[] }>
  }
  | {
    kind: "planner-verification-followup"
    requestedSteps: string[]
    reasons: Array<{ stepName: string; confidence: number; ambiguousIssues: string[] }>
  }
  | {
    kind: "planner-issue-timeline"
    attempt: number
    verifierRound: number
    issues: Array<{ stepName: string; code: string; confidence: number; ownershipMode: string; primaryOwner?: string; suspectedOwners: string[] }>
  }
  | {
    kind: "planner-repair-plan"
    attempt: number
    epoch?: number
    rerunOrder: string[]
    tasks: Array<{ stepName: string; mode: string; ownedIssueCodes: string[]; dependencyIssueCodes: string[] }>
  }
  | {
    kind: "planner-repair-compatibility"
    attempt: number
    mode: "shadow" | "legacy" | "repair"
    activePath: "legacy" | "repair"
    diverged: boolean
    divergenceScore?: number
    divergenceThreshold?: number
    pinnedToLegacy?: boolean
    reasons: string[]
    legacy: { rerunOrder: string[]; tasks: Array<{ stepName: string; mode: string; ownedIssueCodes: string[] }> }
    repair: { rerunOrder: string[]; tasks: Array<{ stepName: string; mode: string; ownedIssueCodes: string[]; dependencyIssueCodes: string[] }> }
  }
  | { kind: "planner-retry"; attempt: number; reason: string; skippedSteps?: number; retrySteps?: number; rerunOrder?: string[] }
  | { kind: "planner-retry-skipped"; reason: string }
  // Delegation decision gate (safety, economics, hard-block)
  | { kind: "planner-delegation-decision"; shouldDelegate: boolean; reason: string; utilityScore: number; safetyRisk: number; confidence: number; hardBlockedTaskClass: string | null }
  // Pipeline budget extension (planner/circuit-breaker)
  | { kind: "planner-budget-extended"; completedSteps: number; effectiveBudget: number; extensions: number }
  // Escalation graph
  | { kind: "planner-escalation"; action: string; reason: string; attempt: number }
  // Retry abort (all steps stuck)
  | { kind: "planner-retry-abort"; reason: string }
  // Per-step retry skip (repeated failure / stub regression)
  | { kind: "planner-retry-skip"; stepName: string; reason: string }
  // Planner delegation entries (child agents spawned by planner)
  | {
    kind: "planner-delegation-start"
    goal: string
    stepName: string
    depth: number
    tools: string[]
    budget: {
      hint: string
      parsedHint: number
      baseBudget: number
      contractFloor: number
      complexityBoost: number
      computedMaxIterations: number
      targetArtifactCount: number
      requiredSourceArtifactCount: number
      acceptanceCriteriaCount: number
      codeArtifactCount: number
      hasComplexImplementation: boolean
      hasBlueprintSource: boolean
      verificationMode: string
    }
    envelope: { workspaceRoot?: string; effectClass?: string; verificationMode?: string; targetArtifacts?: string[] }
  }
  | { kind: "planner-delegation-iteration"; stepName: string; depth: number; iteration: number; maxIterations: number }
  | { kind: "planner-delegation-end"; stepName: string; depth: number; status: "done" | "error"; answer?: string; error?: string }
  // Debug/inspector entries
  | { kind: "system-prompt"; text: string }
  | { kind: "tools-resolved"; tools: Array<{ name: string; description: string; parameters?: Record<string, unknown> }> }
  | { kind: "nudge"; tag: string; message: string; iteration: number }
  | { kind: "llm-request"; iteration: number; messageCount: number; toolCount: number; messages: Array<{ role: string; content: string | null; toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; toolCallId: string | null }> }
  | { kind: "llm-response"; iteration: number; durationMs: number; content: string | null; toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null }
  | { kind: "workspace_diff"; diff: { added: string[]; modified: string[]; deleted: string[] } }
  | { kind: "workspace_diff_applied"; summary: { added: number; modified: number; deleted: number } }

// ── Layout ───────────────────────────────────────────────────────

export interface SavedLayout {
  id: string
  name: string
  config: ViewConfig
  updatedAt: string
}

// ── Dashboard ────────────────────────────────────────────────────

export interface Widget {
  id: string
  type: WidgetType
}

export type WidgetType =
  | "agent-chat"
  | "run-status"
  | "agent-trace"
  | "agent-viz"
  | "live-logs"
  | "audit-trail"
  | "step-timeline"
  | "tool-stats"
  | "run-history"
  | "command-center"
  | "trajectory-replay"
  | "operator-env"
  | "debug-inspector"
  | "platform-dev-log"
  | "universe-viz"
  | "code-seq-diagram"

export interface ViewConfig {
  id: string
  name: string
  widgets: Widget[]
  layouts: Record<string, LayoutItem[]>
}

export interface LayoutItem {
  i: string
  x: number
  y: number
  w: number
  h: number
  minW?: number
  minH?: number
}

// ── WebSocket events ─────────────────────────────────────────────

export interface WsEvent {
  type: string
  data: Record<string, unknown>
  timestamp: string
}

// ── Agent Definitions ────────────────────────────────────────────

export interface AgentDefinition {
  id: string
  name: string
  description: string
  systemPrompt: string
  tools: string[]
  createdAt: string
  updatedAt: string
}

export interface ToolInfo {
  name: string
  description: string
}

// ── Policy ───────────────────────────────────────────────────────

export interface PolicyRule {
  name: string
  effect: "allow" | "require_approval" | "deny"
  condition: string
  parameters: Record<string, unknown>
  createdAt: string
}

// ── Notifications ────────────────────────────────────────────────

export interface NotificationAction {
  label: string
  action: string
  data?: Record<string, unknown>
}

export interface Notification {
  id: string
  type: string       // 'run.failed' | 'run.completed' | 'approval.required' | 'run.recovered'
  title: string
  message: string
  runId: string | null
  stepId: string | null
  actions: NotificationAction[]
  read: boolean
  createdAt: string
}

// ── Rollback ─────────────────────────────────────────────────────

export interface RollbackResult {
  total: number
  compensated: number
  skipped: number
  failed: Array<{ effectId: string; target: string; reason: string }>
}

export interface RollbackPreview {
  wouldCompensate: Array<{ effectId: string; target: string; kind: string; hasSnapshot: boolean }>
  wouldSkip: Array<{ effectId: string; target: string; reason: string }>
  wouldFail: Array<{ effectId: string; target: string; reason: string }>
}
