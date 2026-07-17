import type { LLMClient } from "@mia/agent"
import { AgentOrchestrator } from "../api/runs/orchestrator.js"
import { serverAttachmentService } from "../infra/persistence/attachments.js"
import { buildBootHostDeps, type ServerContext } from "./context.js"

export function createOrchestrator(ctx: ServerContext, llm: LLMClient): AgentOrchestrator {
  const bootHostDeps = buildBootHostDeps(ctx)
  bootHostDeps.attachments = serverAttachmentService

  return new AgentOrchestrator({
    llm,
    workspace: ctx.workspace.get(),
    bootHostDeps
  })
}
