/**
 * useConnectors — load/create/save/delete managed connectors. Mirrors
 * `sync-environments/useSyncEnvironments.ts`, minus the SSE live-refresh (Phase 1
 * reloads the list after each mutation; cross-tab refresh comes later).
 */

import { useCallback, useEffect, useRef, useState } from "react"

import { api } from "../../client/index"
import { downloadBlob } from "../../lib/userDownload"
import type { ConnectorAdmin } from "../../types"

export function useConnectors(
  notify: (message: string) => void,
  notifyError: (message: string) => void,
  enabled: boolean,
) {
  const [items, setItems] = useState<ConnectorAdmin[]>([])
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const inflightRef = useRef<Promise<void> | null>(null)
  const initialLoadRef = useRef(false)
  const notifyRef = useRef(notify)
  const notifyErrorRef = useRef(notifyError)
  notifyRef.current = notify
  notifyErrorRef.current = notifyError

  const load = useCallback(async (): Promise<void> => {
    if (inflightRef.current) {
      await inflightRef.current
      return
    }
    const run = (async (): Promise<void> => {
      setBusy(true)
      try {
        const rows = await api.listConnectors()
        const sorted = [...rows].sort((a, b) => a.id.localeCompare(b.id))
        setItems((current) => (connectorsEqual(current, sorted) ? current : sorted))
      } catch (error) {
        notifyErrorRef.current(error instanceof Error ? error.message : String(error))
      } finally {
        setBusy(false)
        inflightRef.current = null
      }
    })()
    inflightRef.current = run
    await run
  }, [])

  useEffect(() => {
    if (!enabled) {
      initialLoadRef.current = false
      return
    }
    if (initialLoadRef.current) return
    initialLoadRef.current = true
    void load().catch((err: unknown) => { console.error("[mia]", err) })
  }, [enabled, load])

  async function create(fields: Record<string, unknown>): Promise<string | null> {
    const id = String(fields.id ?? fields.name ?? "__new__")
    setSaving(id || "__new__")
    try {
      const result = await api.createConnector(fields)
      await load()
      notifyRef.current(`Created ${result.id}`)
      return result.id
    } catch (error) {
      notifyErrorRef.current(error instanceof Error ? error.message : String(error))
      return null
    } finally {
      setSaving(null)
    }
  }

  async function save(id: string, fields: Record<string, unknown>): Promise<boolean> {
    setSaving(id)
    try {
      await api.updateConnector(id, fields)
      await load()
      notifyRef.current(`Saved ${id}`)
      return true
    } catch (error) {
      notifyErrorRef.current(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setSaving(null)
    }
  }

  async function remove(id: string): Promise<boolean> {
    setSaving(id)
    try {
      await api.deleteConnector(id)
      await load()
      notifyRef.current(`Deleted ${id}`)
      return true
    } catch (error) {
      notifyErrorRef.current(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setSaving(null)
    }
  }

  /** Download connectors.json to the user's machine (secrets included for restore). */
  async function exportFile(): Promise<boolean> {
    setBusy(true)
    try {
      const payload = await api.exportConnectors({ includeSecrets: true })
      const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
        type: "application/json",
      })
      downloadBlob(blob, "connectors.json")
      notifyRef.current(`Exported ${payload.connectors.length} connector(s)`)
      return true
    } catch (error) {
      notifyErrorRef.current(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setBusy(false)
    }
  }

  return {
    items,
    busy,
    saving,
    deleting,
    setDeleting,
    load,
    create,
    save,
    remove,
    exportFile,
  }
}

function connectorsEqual(
  left: ReadonlyArray<ConnectorAdmin>,
  right: ReadonlyArray<ConnectorAdmin>,
): boolean {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) {
    const a = left[i]!
    const b = right[i]!
    if (a.id !== b.id || a.updatedAt !== b.updatedAt) return false
  }
  return true
}
