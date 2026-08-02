/**
 * Isolated LLM step replay for trace playground — no full agent loop.
 */

import type { LLMClient, Message } from "@mia/agent"

export type TraceReplayStepRequest = {
  systemPrompt?: string | null
  input?: string | null
  messages?: Array<{ role: string; content: string | null }>
  maxTokens?: number
}

export type TraceReplayStepResponse = {
  content: string | null
  model: string | null
  usage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  } | null
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
}

function toMessages(body: TraceReplayStepRequest): Message[] {
  if (body.messages && body.messages.length > 0) {
    return body.messages.map((m) => ({
      role: m.role as Message["role"],
      content: m.content,
    }))
  }
  const out: Message[] = []
  if (body.systemPrompt) {
    out.push({ role: "system", content: body.systemPrompt })
  }
  if (body.input) {
    out.push({ role: "user", content: body.input })
  }
  return out
}

export async function replayTraceStep(
  llm: LLMClient,
  body: TraceReplayStepRequest,
): Promise<TraceReplayStepResponse> {
  const messages = toMessages(body)
  if (messages.length === 0) {
    throw new Error("At least one of systemPrompt, input, or messages is required")
  }
  const response = await llm.chat(messages, [], {
    maxTokens: body.maxTokens ?? 4096,
    temperature: 0,
  })
  return {
    content: response.content,
    model: llm.modelHint ?? null,
    usage: response.usage
      ? {
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          totalTokens: response.usage.totalTokens,
        }
      : null,
    toolCalls: (response.toolCalls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments as Record<string, unknown>,
    })),
  }
}
