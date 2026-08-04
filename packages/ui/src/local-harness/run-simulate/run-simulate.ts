/**
 * LOCAL LAPTOP HARNESS — paced SSE without LLMs. Not a product API client.
 */

import { getViewingAsUpn } from "../../lib/viewing-as"
import { api } from "../../client/index"
import { useStore } from "../../state/store"

export type SimScenario = "direct" | "planner-seq" | "planner-parallel"
export type SimPace = "fast" | "normal" | "slow"

const CONFIG_KEY = "mia.local-harness.simulate.config"

export type SimConfig = {
  scenario: SimScenario
  pace: SimPace
}

const DEFAULT_CONFIG: SimConfig = {
  scenario: "direct",
  pace: "normal",
}

const simSession: { runId: string | null } = { runId: null }

export function getSimulatingRunId(): string | null {
  return simSession.runId
}

export function readSimConfig(): SimConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY)
    if (!raw) return DEFAULT_CONFIG
    const parsed = JSON.parse(raw) as Partial<SimConfig>
    const scenario =
      parsed.scenario === "planner-seq" || parsed.scenario === "planner-parallel"
        ? parsed.scenario
        : "direct"
    const pace =
      parsed.pace === "fast" || parsed.pace === "slow" ? parsed.pace : "normal"
    return { scenario, pace }
  } catch {
    return DEFAULT_CONFIG
  }
}

export function writeSimConfig(config: SimConfig): void {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config))
}

type SimulateResponse = {
  runId: string
  threadId: string
  goal: string
  threadTitle: string
}

async function postSimulate(
  config: SimConfig,
  threadId: string | null,
): Promise<SimulateResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  const viewingAs = getViewingAsUpn()
  if (viewingAs) headers["X-Viewing-As"] = viewingAs
  const res = await fetch("/api/runs/simulate", {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify({
      scenario: config.scenario,
      pace: config.pace,
      ...(threadId ? { threadId } : {}),
    }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `HTTP ${res.status}`)
  }
  return (await res.json()) as SimulateResponse
}

/**
 * Start like a real chat turn: prefer the active thread, optimistic run row,
 * never setActiveRun (REST hydrate races wipe live SSE).
 */
export async function startSimulation(config: SimConfig = readSimConfig()): Promise<{
  runId: string
  threadId: string
}> {
  writeSimConfig(config)
  const store = useStore.getState()
  const activeThreadId = store.activeThreadId
  const result = await postSimulate(config, activeThreadId)
  simSession.runId = result.runId

  const now = new Date().toISOString()
  const existing = store.threads.find((t) => t.id === result.threadId)
  store.upsertThread({
    id: result.threadId,
    title: existing?.title || result.threadTitle || "Simulated run",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    runCount: (existing?.runCount ?? 0) + 1,
    pinned: existing?.pinned ?? false,
    archivedAt: existing?.archivedAt ?? null,
  })

  // Thread first, then optimistic run — same order as a real send.
  if (store.activeThreadId !== result.threadId) {
    store.setActiveThreadId(result.threadId)
  }
  store.beginOptimisticRun({
    id: result.runId,
    goal: result.goal || "Simulated run",
    threadId: result.threadId,
  })

  return { runId: result.runId, threadId: result.threadId }
}

export async function stopSimulation(): Promise<void> {
  const runId = simSession.runId
  simSession.runId = null
  if (!runId) return
  try {
    await api.cancelRun(runId)
  } catch (err) {
    console.error("[mia] stop local sim", err)
  }
}

export function clearSimulationIfRun(runId: string | null | undefined): void {
  if (runId && runId === simSession.runId) simSession.runId = null
}
