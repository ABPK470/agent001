/**
 * Universal LLM operation context — binds any in-flight operation's
 * AbortSignal to LLM calls and broadcasts provider-agnostic interaction
 * prompts (device auth, re-auth, missing config) to the UI via SSE.
 *
 * Any provider (Copilot, Databricks, future) calls emitLlmInteractionRequired
 * while waiting for user action; cancellation propagates through the same
 * signal used by proposer scans, agent runs, etc.
 */

import { EventType, type LlmInteractionKind } from "@mia/shared-enums"
import { broadcast } from "../events/broadcaster.js"
import { throwIfCancelled } from "../operations/cancel-registry.js"

export interface LlmInteractionPrompt {
  provider: string
  kind: LlmInteractionKind
  title: string
  message?: string
  url?: string
  code?: string
}

export interface LlmOperationContext {
  signal: AbortSignal
  operationKind?: string
  operationId?: string
}

let bound: LlmOperationContext | null = null

export function bindLlmOperationContext(ctx: LlmOperationContext | null): void {
  bound = ctx
}

export function getLlmOperationContext(): LlmOperationContext | null {
  return bound
}

export function getLlmOperationSignal(): AbortSignal | undefined {
  return bound?.signal
}

export function checkLlmOperationCancelled(): void {
  throwIfCancelled(bound?.signal)
}

export function emitLlmInteractionRequired(prompt: LlmInteractionPrompt): void {
  broadcast({
    type: EventType.LlmInteractionRequired,
    data: {
      ...prompt,
      operationKind: bound?.operationKind,
      operationId: bound?.operationId,
    },
  })
}

export function emitLlmInteractionCleared(): void {
  if (!bound) return
  broadcast({
    type: EventType.LlmInteractionCleared,
    data: {
      operationKind: bound.operationKind,
      operationId: bound.operationId,
    },
  })
}
