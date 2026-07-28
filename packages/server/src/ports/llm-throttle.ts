/**
 * Proactive LLM concurrency throttle at the harness composition root.
 * Raising run concurrency must not instantly 429 the shared provider.
 */

import type { LLMClient, LLMResponse, Message, Tool } from "@mia/agent"

export interface LlmThrottlePort {
  wrap(client: LLMClient): LLMClient
  stats(): { limit: number; active: number; waiting: number }
}

export class LlmThrottle implements LlmThrottlePort {
  private active = 0
  private readonly queue: Array<() => void> = []
  private readonly limit: number

  constructor(limit?: number) {
    this.limit =
      limit ??
      Math.max(1, parseInt(process.env["MAX_CONCURRENT_LLM_CALLS"] ?? "6", 10) || 6)
  }

  wrap(client: LLMClient): LLMClient {
    const self = this
    const wrapped: LLMClient = {
      modelHint: client.modelHint,
      async chat(
        messages: Message[],
        tools: Tool[],
        opts?: {
          signal?: AbortSignal
          maxTokens?: number
          temperature?: number
          onToken?: (token: string) => void
          onFirstToolCallDelta?: () => void
        },
      ): Promise<LLMResponse> {
        await self.acquire()
        try {
          return await client.chat(messages, tools, opts)
        } finally {
          self.release()
        }
      },
    }
    return wrapped
  }

  stats(): { limit: number; active: number; waiting: number } {
    return { limit: this.limit, active: this.active, waiting: this.queue.length }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active++
        resolve()
      })
    })
  }

  private release(): void {
    this.active--
    const next = this.queue.shift()
    if (next) next()
  }
}

const _default = new LlmThrottle()

export function getLlmThrottle(): LlmThrottlePort {
  return _default
}

export function wrapLlmClient(client: LLMClient): LLMClient {
  return _default.wrap(client)
}
