import type { RunProfile, RunTaskType } from "../internal/enums/run-workspace.js"

export interface RunWorkspaceContext {
  readonly runId: string
  readonly sourceRoot: string
  readonly executionRoot: string
  readonly taskType: RunTaskType
  readonly isolated: boolean
  readonly profile: RunProfile
}

export interface WorkspaceDiff {
  readonly added: readonly string[]
  readonly modified: readonly string[]
  readonly deleted: readonly string[]
}
