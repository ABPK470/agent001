import type { SyncExecuteProgress, SyncPlan } from "../../types"

export interface DeployProgress {
  total: number
  done: number
  failed: number
  skipped: number
}

export function deployStepsFromPlan(plan: SyncPlan | null): string[] {
  if (!plan?.executionContract?.flow?.steps) return []
  return plan.executionContract.flow.steps
    .filter((step) => step.phase === "postMetadata")
    .map((step) => step.id)
}

/** Human label for a flow step id — uses plan contract title when available. */
export function syncFlowStepLabel(plan: SyncPlan | null, stepId: string): string {
  const step = plan?.executionContract?.flow?.steps?.find((entry) => entry.id === stepId)
  return step?.title ?? stepId
}

/** Count deploy-step SSE events against the plan's post-metadata step list. */
export function buildDeployProgress(
  events: SyncExecuteProgress[],
  plan: SyncPlan | null
): DeployProgress {
  const stepIds = deployStepsFromPlan(plan)
  const total = stepIds.length
  if (total === 0) return { total: 0, done: 0, failed: 0, skipped: 0 }

  const latest = new Map<string, SyncExecuteProgress["deployStatus"]>()
  for (const event of events) {
    if (event.type !== "deploy-step" || !event.step) continue
    if (event.deployStatus) latest.set(event.step, event.deployStatus)
  }

  let done = 0
  let failed = 0
  let skipped = 0
  for (const id of stepIds) {
    const status = latest.get(id)
    if (status === "done") done += 1
    else if (status === "failed") failed += 1
    else if (status === "skipped") skipped += 1
  }

  return { total, done, failed, skipped }
}
