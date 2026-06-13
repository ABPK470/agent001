import type { AgentOrchestrator } from "../features/runs/orchestrator.js"
import { createWorkspaceRef, type WorkspaceRef } from "./agent-workspace.js"
import type { ServerContext } from "./context.js"

export function bindWorkspace(ctx: ServerContext, orchestrator: AgentOrchestrator): WorkspaceRef {
  return createWorkspaceRef(ctx.workspace.get(), (path) => orchestrator.setWorkspace(path))
}
