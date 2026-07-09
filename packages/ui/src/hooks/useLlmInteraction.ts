import { EventType, isLlmInteractionKind } from "@mia/shared-enums"
import { useEffect, useRef, useState } from "react"

import { useStore } from "../store"

export interface LlmInteraction {
  provider: string
  kind: string
  title: string
  message?: string
  url?: string
  code?: string
  operationKind?: string
  operationId?: string
}

export interface LlmInteractionFilter {
  operationKind?: string
  operationId?: string
}

function matchesFilter(data: Record<string, unknown>, filter?: LlmInteractionFilter): boolean {
  if (!filter) return true
  if (filter.operationKind && data.operationKind !== filter.operationKind) return false
  if (filter.operationId && data.operationId !== filter.operationId) return false
  return true
}

function parseInteraction(data: Record<string, unknown>): LlmInteraction | null {
  const provider = String(data.provider ?? "")
  const kind = String(data.kind ?? "")
  const title = String(data.title ?? "")
  if (!provider || !title || !isLlmInteractionKind(kind)) return null
  return {
    provider,
    kind,
    title,
    message: data.message != null ? String(data.message) : undefined,
    url: data.url != null ? String(data.url) : undefined,
    code: data.code != null ? String(data.code) : undefined,
    operationKind: data.operationKind != null ? String(data.operationKind) : undefined,
    operationId: data.operationId != null ? String(data.operationId) : undefined,
  }
}

/** Subscribe to provider-agnostic LLM interaction prompts from SSE. */
export function useLlmInteraction(filter?: LlmInteractionFilter): {
  interaction: LlmInteraction | null
  dismiss: () => void
} {
  const [interaction, setInteraction] = useState<LlmInteraction | null>(null)
  const logLen = useStore((s) => s.sseEventLog.length)
  const lastIdx = useRef(0)

  useEffect(() => {
    if (!filter?.operationId) setInteraction(null)
  }, [filter?.operationId])

  useEffect(() => {
    const log = useStore.getState().sseEventLog
    if (logLen < lastIdx.current) lastIdx.current = 0
    for (let i = lastIdx.current; i < log.length; i++) {
      const evt = log[i]
      if (!evt) continue
      const type = String(evt.type)
      const data = (evt.data ?? {}) as Record<string, unknown>

      if (type === EventType.LlmInteractionRequired && matchesFilter(data, filter)) {
        const parsed = parseInteraction(data)
        if (parsed) setInteraction(parsed)
      }
      if (type === EventType.LlmInteractionCleared && matchesFilter(data, filter)) {
        setInteraction(null)
      }
    }
    lastIdx.current = log.length
  }, [logLen, filter?.operationKind, filter?.operationId])

  return { interaction, dismiss: () => setInteraction(null) }
}
