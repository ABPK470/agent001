import type { Message } from "@mia/agent"
import { type ExecuteRunInput } from "./types.js"

const CLASSIFICATION_RECENT_MSGS = 6
const CLASSIFICATION_PER_MSG_CAP = 600

export function buildClassificationContext(opts: {
  resumeMessages?: readonly Message[]
  working?: string
  episodic?: string
}): string {
  const parts: string[] = []
  const msgs = opts.resumeMessages ?? []
  const recent: string[] = []
  for (let i = msgs.length - 1; i >= 0 && recent.length < CLASSIFICATION_RECENT_MSGS; i--) {
    const message = msgs[i]
    if (!message) continue
    if (message.role !== "user" && message.role !== "assistant") continue
    const text = typeof message.content === "string" ? message.content : ""
    if (!text) continue
    recent.push(text.slice(0, CLASSIFICATION_PER_MSG_CAP))
  }
  if (recent.length > 0) parts.push(recent.reverse().join("\n"))
  if (opts.working) parts.push(opts.working)
  if (opts.episodic) parts.push(opts.episodic)
  return parts.join("\n")
}

export function buildPersistedToolTrace(steps: Array<{ action: string; input?: Record<string, unknown> | null }>): Array<{
  kind: "tool-call"
  tool: string
  text: string
  argsSummary: string
  argsFormatted: string
}> {
  return steps.map((step) => {
    const input = step.input ?? {}
    const keys = Object.keys(input)
    const argsSummary = keys.length > 0
      ? keys.length === 1 ? `${keys[0]}=${JSON.stringify(input[keys[0]])}` : `${keys.length} args`
      : ""
    return {
      kind: "tool-call",
      tool: step.action,
      text: `${step.action}(${argsSummary || "..."})`,
      argsSummary,
      argsFormatted: JSON.stringify(input, null, 2),
    }
  })
}

export async function acquireRunSlot(input: ExecuteRunInput): Promise<(() => void) | null> {
  try {
    return await input.ctx.queue.acquire(input.runId, input.priority, input.controller.signal)
  } catch {
    input.ctx.activeRuns.delete(input.runId)
    return null
  }
}