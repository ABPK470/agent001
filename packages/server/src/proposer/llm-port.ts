/**
 * Adapter — agent `LLMClient` (chat-style) → proposer `LlmCompletionPort`
 * (single-shot completion).
 *
 * The proposer annotator only needs a text response from a single
 * system+user message pair with a fixed temperature; this thin adapter
 * shields the proposer from the full chat/tool-call surface.
 */

import type { LLMClient, Message } from "@mia/agent"
import { MessageRole } from "@mia/agent"
import type { LlmCompletionPort, LlmCompletionRequest } from "@mia/sync"

export function llmClientAsCompletionPort(client: LLMClient): LlmCompletionPort {
  return {
    async complete(req: LlmCompletionRequest): Promise<string> {
      const messages: Message[] = [
        { role: MessageRole.System, content: req.system },
        { role: MessageRole.User,   content: req.user },
      ]
      const r = await client.chat(messages, [], {
        maxTokens:   req.maxTokens,
        temperature: req.temperature,
      })
      return r.content ?? ""
    },
  }
}
