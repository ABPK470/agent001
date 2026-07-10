/**
 * FreezeWindowsModal — manage freeze windows from entity registry.
 */

import { EventType } from "@mia/shared-enums"
import { Calendar, Loader2, Pencil, Plus, Trash2 } from "lucide-react"
import type { JSX } from "react"
import { useCallback, useMemo, useState } from "react"
import { api } from "../../../api"
import { useInitialCatalogSelection } from "../../../hooks/useInitialCatalogSelection"
import { useLiveReload } from "../../../hooks/useLiveReload"
import { useMe } from "../../../hooks/useMe"
import type { FreezeWindow } from "../../../types"
import { DetailField, DetailGrid } from "../DetailField"
import { ICON_BTN_PRIMARY } from "../chrome"
import { ConfirmModal, GovernanceIconAction } from "../governance/modal-chrome"
import {
  AdminModalEditor,
  AdminModalEditorBody,
  AdminModalEditorHeader,
  AdminModalEmpty,
  AdminModalRail,
  AdminModalSplit,
  AdminRailList,
  AdminRailSection,
} from "../governance/modal-layout"
import { ModalShell } from "../ModalShell"
import { ModalToastStack, useModalToasts } from "../ModalToastStack"
import { FreezeWindowEditorModal } from "./FreezeWindowEditorModal"
import {
  blankFreezeWindowEditState,
  formatFreezeWindowDate,
  freezeWindowStatus,
  freezeWindowToEditState,
  type FreezeWindowEditState,
  type FreezeWindowStatus,
} from "./freeze-window-helpers"

export interface FreezeWindowsModalProps {
  onClose: () => void
  onChanged?: () => void
  stackLevel?: number
  initialWindowId?: string | null
}

export function FreezeWindowsModal({
  onClose,
  onChanged,
  stackLevel = 0,
  initialWindowId = null,
}: FreezeWindowsModalProps): JSX.Element {
  const { me } = useMe()
  const isAdmin = me?.isAdmin ?? false
  const { toasts, pushToast, dismissToast } = useModalToasts()

  const [items, setItems] = useState<FreezeWindow[]>([])
  const [busy, setBusy] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(initialWindowId)
  const [editing, setEditing] = useState<FreezeWindowEditState | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [listQuery, setListQuery] = useState("")

  const load = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const response = await api.listFreezeWindows()
      setItems(response.items)
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [pushToast])

  useLiveReload(load, (type) =>
    type === EventType.FreezeWindowUpserted || type === EventType.FreezeWindowDeleted,
  )

  useInitialCatalogSelection(items, selectedId, setSelectedId, initialWindowId)

  const chosen = useMemo(
    () => items.find((window) => window.id === selectedId) ?? null,
    [items, selectedId],
  )

  const railItems = useMemo(
    () => items.map((window) => ({
      id: window.id,
      label: window.displayName,
      hint: `${window.id} · ${freezeWindowStatus(window)}`,
    })),
    [items],
  )

  async function doDelete(id: string): Promise<void> {
    try {
      await api.deleteFreezeWindow(id)
      if (selectedId === id) setSelectedId(null)
      setDeletingId(null)
      onChanged?.()
      await load()
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <>
      <ModalShell
        title="Freeze windows"
        subtitle="Block sync execute during close or deploy windows. Entities opt in via policies."
        icon={<Calendar size={20} className="text-text-muted" />}
        stackLevel={stackLevel}
        size="focus"
        onClose={onClose}
      >
        <div className="entity-registry relative flex min-h-0 flex-1 flex-col">
          <ModalToastStack toasts={toasts} onDismiss={dismissToast} />
          <AdminModalSplit>
            <AdminModalRail>
              {isAdmin ? (
                <div className="flex shrink-0 justify-end">
                  <button
                    type="button"
                    onClick={() => setEditing(blankFreezeWindowEditState())}
                    className={ICON_BTN_PRIMARY}
                    title="New freeze window"
                    aria-label="New freeze window"
                  >
                    <Plus size={16} />
                  </button>
                </div>
              ) : null}
              <AdminRailSection title="Windows" grow>
                {busy && items.length === 0 ? (
                  <div className="flex items-center gap-2 text-sm text-text-muted">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading…
                  </div>
                ) : (
                  <AdminRailList
                    items={railItems}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    onDelete={isAdmin ? setDeletingId : undefined}
                    query={listQuery}
                    onQueryChange={setListQuery}
                    searchPlaceholder="Search freeze windows…"
                    emptyLabel={isAdmin ? "No freeze windows yet." : "Ask an admin to create one."}
                  />
                )}
              </AdminRailSection>
            </AdminModalRail>

            <AdminModalEditor>
              {chosen ? (
                <>
                  <AdminModalEditorHeader
                    eyebrow="Freeze window"
                    title={chosen.displayName}
                    hint={chosen.id}
                    badge={<FreezeStatusBadge status={freezeWindowStatus(chosen)} />}
                    actions={isAdmin ? (
                      <>
                        <GovernanceIconAction label="Edit" onClick={() => setEditing(freezeWindowToEditState(chosen))}>
                          <Pencil size={15} />
                        </GovernanceIconAction>
                        <GovernanceIconAction label="Delete" onClick={() => setDeletingId(chosen.id)}>
                          <Trash2 size={15} />
                        </GovernanceIconAction>
                      </>
                    ) : undefined}
                  />
                  <AdminModalEditorBody>
                    {chosen.description ? (
                      <p className="text-sm leading-relaxed text-text-muted">{chosen.description}</p>
                    ) : null}
                    <DetailGrid>
                      <DetailField label="Starts" value={formatFreezeWindowDate(chosen.startsAt)} />
                      <DetailField label="Ends" value={formatFreezeWindowDate(chosen.endsAt)} />
                      <DetailField label="Created by" value={chosen.createdBy} />
                    </DetailGrid>
                  </AdminModalEditorBody>
                </>
              ) : (
                <AdminModalEmpty>
                  {items.length === 0
                    ? "Create a freeze window to block sync during month-end close or deploy windows."
                    : "Select a freeze window to inspect details."}
                </AdminModalEmpty>
              )}
            </AdminModalEditor>
          </AdminModalSplit>
        </div>
      </ModalShell>

      {editing && (
        <FreezeWindowEditorModal
          state={editing}
          onChange={setEditing}
          existingIds={items.map((window) => window.id)}
          stackLevel={stackLevel + 1}
          onCancel={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null)
            setSelectedId(saved.id)
            onChanged?.()
            void load()
          }}
          onError={pushToast}
        />
      )}

      {deletingId && (
        <ConfirmModal
          title="Delete freeze window"
          message={`Delete "${deletingId}"? Entities referencing this id will keep the reference until you remove it.`}
          confirmLabel="Delete"
          danger
          stackLevel={editing ? stackLevel + 2 : stackLevel + 1}
          onCancel={() => setDeletingId(null)}
          onConfirm={() => void doDelete(deletingId)}
        />
      )}
    </>
  )
}

function FreezeStatusBadge({ status }: { status: FreezeWindowStatus }): JSX.Element {
  const cls =
    status === "active"
      ? "bg-error-soft text-error border-error/30"
      : status === "scheduled"
        ? "bg-warning-soft text-warning border-warning/30"
        : "bg-overlay-2 text-text-muted border-border-subtle"
  return (
    <span className={`rounded border px-1.5 py-0.5 text-xs uppercase tracking-wider ${cls}`}>
      {status}
    </span>
  )
}
