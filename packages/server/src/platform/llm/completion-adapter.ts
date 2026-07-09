/**
 * Adapter factory — agent `LLMClient` (chat-style) -> proposer
 * `LlmCompletionPort` (single-shot completion).
 *
 * This lives in the server adapter subtree because it is shell-side glue
 * between two package contracts. It is implemented as a closure factory
 * rather than a class because it has no identity, lifecycle, or mutable state.
 */

import type { LLMClient, Message } from "@mia/agent"
import { MessageRole } from "@mia/agent"
import type { LlmCompletionPort, LlmCompletionRequest } from "@mia/sync"
import {
  checkLlmOperationCancelled,
  getLlmOperationSignal,
} from "./operation-context.js"

export function createLlmCompletionAdapter(client: LLMClient): LlmCompletionPort {
  return {
    async complete(req: LlmCompletionRequest): Promise<string> {
      checkLlmOperationCancelled()
      const messages: Message[] = [
        { role: MessageRole.System, content: req.system },
        { role: MessageRole.User, content: req.user }
      ]
      const response = await client.chat(messages, [], {
        maxTokens: req.maxTokens,
        temperature: req.temperature,
        signal: getLlmOperationSignal(),
      })
      checkLlmOperationCancelled()
      return response.content ?? ""
    }
  }
}
