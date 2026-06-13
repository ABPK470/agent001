import { MessageRole, type Message } from "@mia/agent"
import type { BuildContext } from "./types.js"
import { BUS_COORDINATION_SECTION, INFORMATION_DISCLOSURE_SECTION } from "./static-sections.js"

export function buildCoordinationSections(ctx: BuildContext): Message[] {
  const { hasSiblings, coordinationTopic, siblingProgressDigest, isAdmin } = ctx
  const messages: Message[] = []

  if (hasSiblings) {
    messages.push({
      role: MessageRole.System,
      content: BUS_COORDINATION_SECTION,
      section: "system_runtime"
    })
    if (coordinationTopic) {
      messages.push({
        role: MessageRole.System,
        content:
          `<coordination_topic>\n` +
          `Use topic="${coordinationTopic}" for Status / Question / Answer / Broadcast\n` +
          `messages directed at siblings under the same parent. The orchestrator\n` +
          `auto-publishes your iteration progress to this topic on your behalf,\n` +
          `so siblings already see your liveness — only post here when you have\n` +
          `something a sibling actually needs (a result they're blocked on, a\n` +
          `question only they can answer, etc.).\n` +
          `</coordination_topic>`,
        section: "system_runtime"
      })
    }
    if (siblingProgressDigest) {
      messages.push({
        role: MessageRole.System,
        content: `<sibling_progress>\n${siblingProgressDigest}\n</sibling_progress>`,
        section: "system_runtime"
      })
    }
  }

  if (!isAdmin) {
    messages.push({
      role: MessageRole.System,
      content: INFORMATION_DISCLOSURE_SECTION,
      section: "system_anchor"
    })
  }

  return messages
}
