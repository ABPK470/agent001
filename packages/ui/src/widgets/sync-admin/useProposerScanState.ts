import { EventType } from "@mia/shared-enums"
import { useCallback, useEffect, useRef, useState } from "react"

import { api } from "../../api"
import { useStore } from "../../store"

export interface ActiveScan {
  runId: string
  source: string
  target: string
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
  noteScanStarted: (source: string, target: string) => void
  cancelScan: () => Promise<void>
  cancelBusy: boolean
} {
  const [scanning, setScanning] = useState<ActiveScan | null>(null)
  const [cancelBusy, setCancelBusy] = useState(false)
  const logLen = useStore((s) => s.sseEventLog.length)
  const lastIdx = useRef(0)

  useEffect(() => {
    void api.listProposerRuns({ limit: 10 }).then((rows) => {
      const active = rows.find((r) => r.status === "running" || r.status === "pending")
      if (!active) return
      const id = String(active.id ?? "")
      const source = String(active.source ?? "")
      const target = String(active.target ?? "")
      if (id && source && target) {
        setScanning({ runId: id, source, target })
      }
    }).catch(() => {})
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
        if (runId && envPair?.source && envPair?.target) {
          setScanning({ runId, source: envPair.source, target: envPair.target })
        }
      }

      if (type === EventType.SyncProposerRunCompleted) {
        setScanning(null)
        onCompleted?.(Number(data.inserted ?? 0))
      }

      if (type === EventType.SyncProposerRunFailed) {
        setScanning(null)
        onFailed?.(String(data.error ?? "Scan failed"))
      }

      if (type === EventType.SyncProposerRunCancelled) {
        setScanning(null)
        onCancelled?.(String(data.reason ?? "Scan cancelled"))
      }
    }
    lastIdx.current = log.length
  }, [logLen, onCompleted, onFailed, onCancelled])

  const noteScanStarted = useCallback((source: string, target: string) => {
    setScanning((prev) => prev ?? { runId: "", source, target })
  }, [])

  const cancelScan = useCallback(async (): Promise<void> => {
    if (!scanning?.runId) {
      setScanning(null)
      return
    }
    setCancelBusy(true)
    try {
      await api.cancelProposerRun(scanning.runId)
    } finally {
      setCancelBusy(false)
    }
  }, [scanning?.runId])

  return {
    scanning,
    noteScanStarted,
    cancelScan,
    cancelBusy,
  }
}
