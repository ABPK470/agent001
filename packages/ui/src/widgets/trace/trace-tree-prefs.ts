/**
 * Trace left-tree open/fold prefs — survive view switches (widget remount).
 * sessionStorage, keyed by tile id + run id.
 */

import { emptyOpen, type FoldMode, type OpenState } from "./open-state"

export type TraceTreePrefs = {
  preamble: boolean
  contextPrompt: boolean
  contextTools: boolean
  calls: number[]
  sent: number[]
  received: number[]
  messages: string[]
  tools: string[]
  phases: string[]
  work: string[]
  foldMode: FoldMode
}

const STORAGE_PREFIX = "mia:trace-tree-open:"

/** Survive remount even if a buggy write races before the DAG is ready. */
const memoryByKey = new Map<string, TraceTreePrefs>()

export function traceTreePrefsKey(
  tileId: string | null | undefined,
  runId: string | null | undefined,
): string | null {
  if (!tileId?.trim() || !runId?.trim()) return null
  return `${STORAGE_PREFIX}${tileId}:${runId}`
}

function openStateHasOpens(state: OpenState): boolean {
  return (
    state.preamble ||
    state.contextPrompt ||
    state.contextTools ||
    state.calls.size > 0 ||
    state.sent.size > 0 ||
    state.received.size > 0 ||
    state.messages.size > 0 ||
    state.tools.size > 0 ||
    state.phases.size > 0 ||
    state.work.size > 0 ||
    state.foldMode === "expanded"
  )
}

function parseFoldMode(raw: unknown): FoldMode {
  return raw === "expanded" ? "expanded" : "collapsed"
}

function parseNumberArray(raw: unknown): number[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((v): v is number => typeof v === "number" && Number.isFinite(v))
}

function parseStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((v): v is string => typeof v === "string")
}

export function serializeTraceOpenState(state: OpenState): TraceTreePrefs {
  return {
    preamble: state.preamble,
    contextPrompt: state.contextPrompt,
    contextTools: state.contextTools,
    calls: [...state.calls],
    sent: [...state.sent],
    received: [...state.received],
    messages: [...state.messages],
    tools: [...state.tools],
    phases: [...state.phases],
    work: [...state.work],
    foldMode: state.foldMode,
  }
}

export function deserializeTraceOpenState(prefs: TraceTreePrefs): OpenState {
  return {
    preamble: prefs.preamble,
    contextPrompt: prefs.contextPrompt,
    contextTools: prefs.contextTools,
    calls: new Set(prefs.calls),
    sent: new Set(prefs.sent),
    received: new Set(prefs.received),
    messages: new Set(prefs.messages),
    tools: new Set(prefs.tools),
    phases: new Set(prefs.phases),
    work: new Set(prefs.work),
    foldMode: prefs.foldMode,
  }
}

export function readTraceTreePrefs(
  tileId: string | null | undefined,
  runId: string | null | undefined,
  storage: Pick<Storage, "getItem"> = sessionStorage,
): OpenState | null {
  const key = traceTreePrefsKey(tileId, runId)
  if (!key) return null
  const fromMemory = memoryByKey.get(key)
  try {
    const raw = storage.getItem(key)
    if (!raw) {
      return fromMemory ? deserializeTraceOpenState(fromMemory) : null
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const prefs: TraceTreePrefs = {
      preamble: parsed["preamble"] === true,
      contextPrompt: parsed["contextPrompt"] === true,
      contextTools: parsed["contextTools"] === true,
      calls: parseNumberArray(parsed["calls"]),
      sent: parseNumberArray(parsed["sent"]),
      received: parseNumberArray(parsed["received"]),
      messages: parseStringArray(parsed["messages"]),
      tools: parseStringArray(parsed["tools"]),
      phases: parseStringArray(parsed["phases"]),
      work: parseStringArray(parsed["work"]),
      foldMode: parseFoldMode(parsed["foldMode"]),
    }
    const state = deserializeTraceOpenState(prefs)
    if (!openStateHasOpens(state) && fromMemory && openStateHasOpens(deserializeTraceOpenState(fromMemory))) {
      return deserializeTraceOpenState(fromMemory)
    }
    memoryByKey.set(key, prefs)
    return state
  } catch {
    return fromMemory ? deserializeTraceOpenState(fromMemory) : null
  }
}

export function writeTraceTreePrefs(
  tileId: string | null | undefined,
  runId: string | null | undefined,
  state: OpenState,
  storage: Pick<Storage, "setItem" | "removeItem"> = sessionStorage,
): void {
  const key = traceTreePrefsKey(tileId, runId)
  if (!key) return
  try {
    const prefs = serializeTraceOpenState(state)
    memoryByKey.set(key, prefs)
    if (!openStateHasOpens(state)) {
      storage.removeItem(key)
      return
    }
    storage.setItem(key, JSON.stringify(prefs))
  } catch (err: unknown) {
    console.error("[mia]", err)
  }
}

export function defaultTraceOpenState(): OpenState {
  return emptyOpen()
}
