/**
 * system_runtime sections — tools, workspace layout, and attachment manifest.
 * Droppable under token pressure; describes what the agent can call this run.
 */

import { MessageRole, type Message } from "@mia/agent"
import { buildHostedRuntimeContext, buildToolContext, getWorkspaceContext } from "../prompt/builder.js"
import type { BuildContext } from "./types.js"
import { buildAttachmentManifest } from "./attachments.js"

export async function buildRuntimeSections(ctx: BuildContext): Promise<Message[]> {
  const { opts, decision, isAdmin } = ctx
  const messages: Message[] = []

  const toolCtx = buildToolContext(opts.allTools, {
    ...(opts.host ? { host: opts.host } : {}),
    includeMssqlKnowledge: decision.includeMssqlKnowledge,
    mssqlKnowledgeMode: decision.mssqlKnowledgeMode,
    includeMssqlCatalog: decision.includeMssqlCatalog,
    includeMssqlGuidance: decision.includeMssqlGuidance
  })
  if (toolCtx) {
    messages.push({
      role: MessageRole.System,
      content: toolCtx.trim(),
      section: "system_runtime"
    })
  }

  const { runWorkspace } = opts
  if (runWorkspace.profile === "hosted") {
    messages.push({
      role: MessageRole.System,
      content: buildHostedRuntimeContext({ sandboxRoot: runWorkspace.executionRoot }),
      section: "system_runtime"
    })
  } else if (isAdmin && runWorkspace.executionRoot) {
    const wsContext = await getWorkspaceContext(runWorkspace.executionRoot)
    messages.push({
      role: MessageRole.System,
      content: [`Workspace: ${runWorkspace.executionRoot}`, wsContext, ""].join("\n"),
      section: "system_runtime"
    })
  }

  const attachmentBlock = buildAttachmentManifest(opts.attachmentIds ?? [])
  if (attachmentBlock) {
    messages.push({
      role: MessageRole.System,
      content: attachmentBlock,
      section: "system_runtime"
    })
  }

  return messages
}
