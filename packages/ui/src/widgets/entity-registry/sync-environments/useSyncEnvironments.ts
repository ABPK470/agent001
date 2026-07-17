import { EventType } from "@mia/shared-enums"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { api } from "../../../client/index"
import { useStore } from "../../../state/store"
import type { SyncEnvironmentAdmin } from "../../../types"

function envEventCount(log: ReadonlyArray<{ type: unknown }>): number {
  let count = 0
  for (const event of log) {
    const type = String(event.type)
    if (type === EventType.SyncEnvUpdate || type === EventType.SyncEnvReset) count++
  }
  return count
}

export function useSyncEnvironments(
  notify: (message: string) => void,
  notifyError: (message: string) => void,
  enabled: boolean,
) {
  const [items, setItems] = useState<SyncEnvironmentAdmin[]>([])
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [builtinEditUnlocked, setBuiltinEditUnlocked] = useState(false)

  const inflightRef = useRef<Promise<void> | null>(null)
  const initialLoadRef = useRef(false)
  const notifyRef = useRef(notify)
  const notifyErrorRef = useRef(notifyError)
  notifyRef.current = notify
  notifyErrorRef.current = notifyError

  const envTick = useStore((s) => envEventCount(s.sseEventLog))
  const lastEnvTickRef = useRef<number | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (inflightRef.current) {
      await inflightRef.current
      return
    }

    const run = (async (): Promise<void> => {
      setBusy(true)
      try {
        const rows = await api.listSyncEnvironments()
        const sorted = [...rows].sort((a, b) => a.ringOrder - b.ringOrder || a.name.localeCompare(b.name))
        setItems((current) => (environmentsEqual(current, sorted) ? current : sorted))
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
      lastEnvTickRef.current = null
      return
    }
    if (initialLoadRef.current) return
    initialLoadRef.current = true
    void load()
  }, [enabled, load])

  useEffect(() => {
    if (!enabled) return
    if (lastEnvTickRef.current === null) {
      lastEnvTickRef.current = envTick
      return
    }
    if (envTick === lastEnvTickRef.current) return
    lastEnvTickRef.current = envTick
    void load()
  }, [enabled, envTick, load])

  const catalogItems = useMemo(
    () =>
      items.map((item) => ({
        id: item.name,
        label: item.displayName,
        hint: `order ${item.ringOrder} · ${item.role}`,
        builtIn: Boolean(item.builtIn),
      })),
    [items],
  )

  async function create(fields: Record<string, unknown>): Promise<void> {
    const name = String(fields.name ?? "")
    setSaving(name || "__new__")
    try {
      await api.createSyncEnvironment(fields)
      await load()
      notifyRef.current(`Created ${name}`)
    } catch (error) {
      notifyErrorRef.current(error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      setSaving(null)
    }
  }

  async function save(name: string, fields: Record<string, unknown>, allowBuiltinEdit: boolean): Promise<void> {
    setSaving(name)
    try {
      await api.updateSyncEnvironment(name, allowBuiltinEdit ? { ...fields, allowBuiltinEdit: true } : fields)
      await load()
      notifyRef.current(`Saved ${name}`)
    } catch (error) {
      notifyErrorRef.current(error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      setSaving(null)
    }
  }

  async function remove(name: string, allowBuiltinEdit: boolean): Promise<void> {
    setSaving(name)
    try {
      await api.deleteSyncEnvironment(name, allowBuiltinEdit ? { allowBuiltinEdit: true } : undefined)
      await load()
      notifyRef.current(`Deleted ${name}`)
    } catch (error) {
      notifyErrorRef.current(error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      setSaving(null)
    }
  }

  return {
    items,
    busy,
    saving,
    catalogItems,
    deleting,
    setDeleting,
    builtinEditUnlocked,
    setBuiltinEditUnlocked,
    load,
    create,
    save,
    remove,
  }
}

function environmentsEqual(
  left: ReadonlyArray<SyncEnvironmentAdmin>,
  right: ReadonlyArray<SyncEnvironmentAdmin>,
): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    const a = left[index]!
    const b = right[index]!
    if (a.name !== b.name || a.updatedAt !== b.updatedAt) return false
  }
  return true
}
