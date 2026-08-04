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

async function postSimulate(config: SimConfig): Promise<{ runId: string; threadId: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  const viewingAs = getViewingAsUpn()
  if (viewingAs) headers["X-Viewing-As"] = viewingAs
  const res = await fetch("/api/runs/simulate", {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify({ scenario: config.scenario, pace: config.pace }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `HTTP ${res.status}`)
  }
  return (await res.json()) as { runId: string; threadId: string }
}

export async function startSimulation(config: SimConfig = readSimConfig()): Promise<{
  runId: string
  threadId: string
}> {
  writeSimConfig(config)
  const result = await postSimulate(config)
  simSession.runId = result.runId
  const store = useStore.getState()
  store.setActiveThreadId(result.threadId)
  store.setActiveRun(result.runId)
  return result
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
