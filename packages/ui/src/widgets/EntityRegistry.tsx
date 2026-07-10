/**
 * Entity registry — minimal shell: list + task-focused detail.
 */

import { Trash2 } from "lucide-react"
import type { JSX } from "react"
import { useEffect, useMemo, useState } from "react"
import { api } from "../api"
import { ToastStack, useWidgetToasts } from "../hooks/useWidgetToasts"
import { useMe } from "../hooks/useMe"
import { useStore } from "../store"
import type { EntityRegistryDefinition, EntityRegistryHistoryEntry } from "../types"
import { Empty } from "./sync-admin/shared"
import {
  EntityDetailContent,
  EntityDetailToolbar,
  type EntityTab,
} from "./entity-registry/EntityDetail"
import { EntityEditModal } from "./entity-registry/EntityEditModal"
import { EntityHistoryModal } from "./entity-registry/EntityHistoryModal"
import { EntityList } from "./entity-registry/EntityList"
import { EntityRailHeader } from "./entity-registry/EntityRailHeader"
import { WIDGET_ENVELOPE } from "./entity-registry/chrome"
import { ModalShell } from "./entity-registry/ModalShell"
import { PublishDefinitionsModal } from "./entity-registry/PublishDefinitionsModal"
import { SyncMetadataModal } from "./entity-registry/SyncMetadataModal"

export function EntityRegistry(): JSX.Element {
  const { me } = useMe()
  const isAdmin = me?.isAdmin ?? false

  const [items, setItems] = useState<EntityRegistryDefinition[]>([])
  const [reservedEntityIds, setReservedEntityIds] = useState<string[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tab, setTab] = useState<EntityTab>("overview")
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<EntityRegistryHistoryEntry[]>([])
  const [yamlText, setYamlText] = useState("")
  const [busy, setBusy] = useState(false)
  const { toasts, dismissToast, notify, notifyError } = useWidgetToasts()
  const [modal, setModal] = useState<null | { kind: "new" } | { kind: "edit"; def: EntityRegistryDefinition }>(null)
  const [syncMetadataOpen, setSyncMetadataOpen] = useState(false)
  const [publishOpen, setPublishOpen] = useState(false)
  const [exportingConfig, setExportingConfig] = useState(false)
  const [retireCandidate, setRetireCandidate] = useState<EntityRegistryDefinition | null>(null)

  const selected = useMemo(
    () => items.find((i) => i.id === selectedId) ?? null,
    [items, selectedId],
  )

  async function refreshList(opts: { keepSelection?: boolean } = {}) {
    setBusy(true)
    try {
      const [res, retiredRes] = await Promise.all([
        api.listEntityRegistry({ includeRetired: false }),
        api.listEntityRegistry({ includeRetired: true }),
      ])
      setItems(res.items)
      setReservedEntityIds(retiredRes.items.map((item) => item.id))
      setSelectedId((current) => {
        if (current && !res.items.some((item) => item.id === current)) {
          return res.items[0]?.id ?? null
        }
        if (!opts.keepSelection && !current && res.items.length > 0) {
          return res.items[0]!.id
        }
        return current
      })
    } catch (e) {
      notifyError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => { void refreshList() }, [])

  const entityEventCount = useStore((s) =>
    s.sseEventLog.filter((e) => typeof e.type === "string" && e.type.startsWith("entity_registry.")).length,
  )
  useEffect(() => {
    if (entityEventCount === 0) return
    void refreshList({ keepSelection: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityEventCount])

  useEffect(() => {
    if (!selectedId) return
    setHistoryOpen(false)
    if (tab === "overview") {
      void api.getEntityRegistryYaml(selectedId).then(setYamlText).catch((e) =>
        notifyError(String(e)))
    }
  }, [tab, selectedId])

  useEffect(() => {
    if (!selectedId || !historyOpen) return
    void api.getEntityRegistryHistory(selectedId).then(setHistory).catch((e) =>
      notifyError(String(e)))
  }, [selectedId, historyOpen])

  const activeEntityCount = useMemo(
    () => items.filter((item) => !item.retiredAt).length,
    [items],
  )

  async function doRetire() {
    if (!retireCandidate || !isAdmin) return
    setBusy(true)
    try {
      await api.retireEntityRegistry(retireCandidate.id)
      setRetireCandidate(null)
      await refreshList({ keepSelection: true })
    } catch (e) {
      notifyError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function openPublish(): void {
    setPublishOpen(true)
  }

  async function exportConfiguration(): Promise<void> {
    if (!isAdmin || exportingConfig) return
    setExportingConfig(true)
    try {
      const { filename, bytes } = await api.downloadPlatformArtifacts()
      notify(`Exported configuration (${filename}, ${bytes.toLocaleString()} bytes)`)
    } catch (e) {
      notifyError(e instanceof Error ? e.message : String(e))
    } finally {
      setExportingConfig(false)
    }
  }

  function openHistory(entity: EntityRegistryDefinition): void {
    setSelectedId(entity.id)
    setHistoryOpen(true)
  }

  function openEdit(entity: EntityRegistryDefinition): void {
    setSelectedId(entity.id)
    setModal({ kind: "edit", def: entity })
  }

  function openRetire(entity: EntityRegistryDefinition): void {
    setSelectedId(entity.id)
    setRetireCandidate(entity)
  }

  return (
    <>
      <div className="entity-registry relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-panel p-3">
        <div className={WIDGET_ENVELOPE}>
          <div className="entity-registry-shell grid min-h-0 flex-1 overflow-hidden">
            <aside className="entity-rail flex min-h-0 flex-col border-r border-border-subtle">
              <EntityRailHeader
                isAdmin={isAdmin}
                busy={busy || exportingConfig}
                onNew={() => setModal({ kind: "new" })}
                onSyncMetadata={() => setSyncMetadataOpen(true)}
                onPublish={openPublish}
                onExportConfig={() => void exportConfiguration()}
              />
              <div className="entity-rail-scroll min-h-0 flex-1 overflow-y-auto">
                <EntityList
                  items={items}
                  selectedId={selectedId}
                  isAdmin={isAdmin}
                  busy={busy}
                  onSelect={setSelectedId}
                  onHistory={openHistory}
                  onEdit={openEdit}
                  onRetire={openRetire}
                />
              </div>
            </aside>

            <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
              {selected
                ? (
                  <>
                    <EntityDetailToolbar def={selected} tab={tab} onTab={setTab} />
                    <EntityDetailContent
                      def={selected}
                      tab={tab}
                      yamlText={yamlText}
                      isAdmin={isAdmin}
                    />
                  </>
                )
                : (
                  <Empty title="Select an entity" />
                )}
            </div>
          </div>
        </div>
        <ToastStack toasts={toasts} onDismiss={dismissToast} />
      </div>

      {historyOpen && selectedId && (
        <EntityHistoryModal
          entityId={selectedId}
          entries={history}
          onClose={() => setHistoryOpen(false)}
        />
      )}
      {modal?.kind === "new" && (
        <EntityEditModal
          mode="new"
          initial={null}
          reservedEntityIds={reservedEntityIds}
          onClose={() => setModal(null)}
          onSaved={(id) => { setSelectedId(id); void refreshList({ keepSelection: true }) }}
        />
      )}
      {modal?.kind === "edit" && (
        <EntityEditModal
          mode="edit"
          initial={modal.def}
          onClose={() => setModal(null)}
          onSaved={() => void refreshList({ keepSelection: true })}
        />
      )}
      {syncMetadataOpen && (
        <SyncMetadataModal
          onClose={() => setSyncMetadataOpen(false)}
          onChanged={() => void refreshList({ keepSelection: true })}
        />
      )}
      {publishOpen && (
        <PublishDefinitionsModal
          entityCount={activeEntityCount}
          onClose={() => setPublishOpen(false)}
          onPublished={(res) => {
            notify(`Published ${res.definitionCount} definition(s)`)
            void refreshList({ keepSelection: true })
          }}
        />
      )}
      {retireCandidate && (
        <ModalShell
          title={`Delete · ${retireCandidate.id}`}
          size="detail"
          onClose={() => { if (!busy) setRetireCandidate(null) }}
          footer={(
            <div className="ml-auto flex gap-2">
              <button type="button" onClick={() => setRetireCandidate(null)} disabled={busy} className="rounded border border-border-subtle px-3 py-1.5 text-xs text-text-muted">
                Cancel
              </button>
              <button type="button" onClick={() => void doRetire()} disabled={busy} className="rounded bg-rose-500 px-3 py-1.5 text-xs text-white">
                <Trash2 className="h-3 w-3 inline" /> Delete
              </button>
            </div>
          )}
        >
          <p className="px-5 py-4 text-sm text-text-muted">
            Remove this entity from the registry. Version history is kept for audit; other entities that reference it are not changed automatically.
          </p>
        </ModalShell>
      )}
    </>
  )
}
