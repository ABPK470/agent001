import { EventType } from "@mia/shared-enums"
import { useCallback, useEffect, useRef, useState } from "react"

import { api } from "../../client/index"
import { useStore } from "../../state/store"

export interface ActiveScan {
  runId: string
  source: string
  target: string
}

function pairKey(source: string, target: string): string {
  return `${source}\0${target}`
}

async function resolveActiveRunId(scan: ActiveScan): Promise<string | null> {
  if (scan.runId) return scan.runId
  const rows = await api.listProposerRuns({ limit: 20 })
  const match = rows.find((row) => {
    const status = String(row.status ?? "")
    const source = String(row.source ?? "")
    const target = String(row.target ?? "")
    return (status === "running" || status === "pending")
      && source === scan.source
      && target === scan.target
  })
  const id = match ? String(match.id ?? "") : ""
  return id || null
}

export function useProposerScanState({
  onCompleted,
  onFailed,
  onCancelled,
}: {
  onCompleted?: (inserted: number) => void
  onFailed?: (message: string) => void
  onCancelled?: (message: string) => void
} = {}): {
  scanning: ActiveScan | null
  noteScanStarted: (source: string, target: string, runId?: string) => void
  cancelScan: () => Promise<ActiveScan | null>
  cancelBusy: boolean
} {
  const [scanning, setScanning] = useState<ActiveScan | null>(null)
  const [cancelBusy, setCancelBusy] = useState(false)
  const logLen = useStore((s) => s.sseEventLog.length)
  const lastIdx = useRef(0)
  const suppressedPairsRef = useRef<Set<string>>(new Set())
  const suppressedRunIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    void api.listProposerRuns({ limit: 10 }).then((rows) => {
      const active = rows.find((r) => r.status === "running" || r.status === "pending")
      if (!active) return
      const id = String(active.id ?? "")
      const source = String(active.source ?? "")
      const target = String(active.target ?? "")
      if (!id || !source || !target) return
      if (suppressedRunIdsRef.current.has(id)) return
      if (suppressedPairsRef.current.has(pairKey(source, target))) return
      setScanning({ runId: id, source, target })
    }).catch((err: unknown) => { console.error("[mia]", err) })
  }, [])

  useEffect(() => {
    const log = useStore.getState().sseEventLog
    if (logLen < lastIdx.current) lastIdx.current = 0
    for (let i = lastIdx.current; i < log.length; i++) {
      const evt = log[i]
      if (!evt) continue
      const type = String(evt.type)
      const data = (evt.data ?? {}) as Record<string, unknown>

      if (type === EventType.SyncProposerRunStarted) {
        const envPair = data.envPair as { source?: string; target?: string } | undefined
        const runId = String(data.runId ?? "")
        if (!runId || !envPair?.source || !envPair?.target) continue
        if (suppressedRunIdsRef.current.has(runId)) continue
        if (suppressedPairsRef.current.has(pairKey(envPair.source, envPair.target))) continue
        setScanning({ runId, source: envPair.source, target: envPair.target })
      }

      if (type === EventType.SyncProposerRunCompleted) {
        const runId = String(data.runId ?? "")
        suppressedRunIdsRef.current.delete(runId)
        setScanning(null)
        onCompleted?.(Number(data.inserted ?? 0))
      }

      if (type === EventType.SyncProposerRunFailed) {
        const runId = String(data.runId ?? "")
        suppressedRunIdsRef.current.delete(runId)
        setScanning(null)
        onFailed?.(String(data.error ?? "Scan failed"))
      }

      if (type === EventType.SyncProposerRunCancelled) {
        const runId = String(data.runId ?? "")
        const envPair = data.envPair as { source?: string; target?: string } | undefined
        if (runId) suppressedRunIdsRef.current.add(runId)
        if (envPair?.source && envPair?.target) {
          suppressedPairsRef.current.add(pairKey(envPair.source, envPair.target))
        }
        setScanning(null)
        onCancelled?.(String(data.reason ?? "Scan cancelled"))
      }
    }
    lastIdx.current = log.length
  }, [logLen, onCompleted, onFailed, onCancelled])

  const noteScanStarted = useCallback((source: string, target: string, runId = "") => {
    suppressedPairsRef.current.delete(pairKey(source, target))
    if (runId) suppressedRunIdsRef.current.delete(runId)
    setScanning((prev) => {
      if (prev?.source === source && prev.target === target) {
        return runId ? { ...prev, runId } : prev
      }
      return { runId, source, target }
    })
  }, [])

  const cancelScan = useCallback(async (): Promise<ActiveScan | null> => {
    if (!scanning) return null

    const snapshot = scanning
    const key = pairKey(snapshot.source, snapshot.target)
    suppressedPairsRef.current.add(key)
    setScanning(null)

    setCancelBusy(true)
    try {
      const runId = await resolveActiveRunId(snapshot)
      if (runId) {
        suppressedRunIdsRef.current.add(runId)
        await api.cancelProposerRun(runId)
      }
    } finally {
      setCancelBusy(false)
    }
    return snapshot
  }, [scanning])

  return {
    scanning,
    noteScanStarted,
    cancelScan,
    cancelBusy,
  }
}
