/**
 * Sync / reconciliation platform bootstrap.
 *
 * Starts background services for the F1 reconciliation stack: proposer
 * scheduler, evidence signing, sync LLM port, and ops notifications.
 */

import type { AgentHost, LLMClient } from "@mia/agent"
import type { LlmCompletionPort } from "@mia/sync"
import { dispatchNotification } from "../features/notifications/application/delivery-routing.js"
import { startScheduler } from "../features/proposer/index.js"
import { createLlmCompletionAdapter } from "../platform/llm/index.js"
import { tryBuildSignerFromEnv } from "../platform/persistence/index.js"
import type { Signer } from "../platform/persistence/evidence.js"
import { subscribeToEvents } from "../platform/events/broadcaster.js"
import { resolveEvidenceDir } from "../platform/persistence/server-data-dir.js"

export interface SyncPlatformRuntime {
  readonly evidenceStorageRoot: string
  readonly evidenceSigner: Signer | null
  readonly llmPortHolder: { current: LlmCompletionPort }
  readonly unsubscribeNotifications: () => void
}

export function startSyncPlatform(opts: { bootHost: AgentHost; llm: LLMClient }): SyncPlatformRuntime {
  const evidenceStorageRoot = resolveEvidenceDir()
  const signerResult = tryBuildSignerFromEnv()
  if (!signerResult.ok) {
    console.warn(
      `[evidence] signer not configured (kind=${signerResult.error.kind}): ${signerResult.error.message}`
    )
  } else {
    console.log(`[evidence] signer ready: ${signerResult.signer.id} (${signerResult.signer.alg})`)
  }
  const evidenceSigner = signerResult.ok ? signerResult.signer : null

  const llmPortHolder = { current: createLlmCompletionAdapter(opts.llm) }
  startScheduler({ host: opts.bootHost, llm: () => llmPortHolder.current })

  const unsubscribeNotifications = subscribeToEvents((ev) => {
    try {
      const data = (ev.data ?? {}) as Record<string, unknown>
      const tenantId = (typeof data["tenantId"] === "string" ? data["tenantId"] : null) ?? "_default"
      dispatchNotification({
        tenantId,
        eventType: ev.type,
        riskTier: typeof data["riskTier"] === "string" ? (data["riskTier"] as string) : undefined,
        envPair: typeof data["envPair"] === "string" ? (data["envPair"] as string) : undefined,
        entityType: typeof data["entityType"] === "string" ? (data["entityType"] as string) : undefined,
        context: { ...data, eventType: ev.type }
      })
    } catch (error) {
      console.warn("[notifications] dispatch failed:", error instanceof Error ? error.message : error)
    }
  })

  return { evidenceStorageRoot, evidenceSigner, llmPortHolder, unsubscribeNotifications }
}
