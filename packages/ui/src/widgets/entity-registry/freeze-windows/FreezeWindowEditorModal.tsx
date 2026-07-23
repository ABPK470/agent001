import { Calendar, Loader2, Save } from "lucide-react"
import type { JSX } from "react"
import { api } from "../../../client/index"
import type { FreezeWindow, FreezeWindowSaveRequest } from "../../../types"
import { ConfirmModal, ModalBtnPrimary, ModalBtnSecondary } from "../governance/modal-chrome"
import {
  AdminModalCanvas,
  AdminModalRoot,
  FormFieldGroup,
  FormSectionCard,
} from "../governance/modal-layout"
import { ModalShell } from "../ModalShell"
import {
  deriveFreezeWindowSlug,
  type FreezeWindowEditState,
  uniquifyFreezeWindowId,
  validateFreezeWindowEditState,
} from "./freeze-window-helpers"

export function FreezeWindowEditorModal({
  state,
  onChange,
  existingIds,
  stackLevel = 1,
  onCancel,
  onSaved,
  onError,
}: {
  state: FreezeWindowEditState
  onChange: (next: FreezeWindowEditState) => void
  existingIds: readonly string[]
  stackLevel?: number
  onCancel: () => void
  onSaved: (saved: FreezeWindow) => void
  onError: (message: string) => void
}): JSX.Element {
  function patch(partial: Partial<FreezeWindowEditState>): void {
    onChange({ ...state, ...partial })
  }

  function onName(value: string): void {
    if (state.isNew && !state.idTouched) {
      const derived = uniquifyFreezeWindowId(deriveFreezeWindowSlug(value), existingIds)
      patch({ displayName: value, id: derived })
    } else {
      patch({ displayName: value })
    }
  }

  const missing = validateFreezeWindowEditState(state)

  async function save(): Promise<void> {
    if (missing) return onError(missing)
    const body: FreezeWindowSaveRequest = {
      id: state.id,
      displayName: state.displayName.trim(),
      description: state.description.trim(),
      startsAt: new Date(state.startsLocal).toISOString(),
      endsAt: new Date(state.endsLocal).toISOString(),
    }
    patch({ busy: true })
    try {
      const saved = await api.upsertFreezeWindow(body)
      onSaved(saved)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
      patch({ busy: false })
    }
  }

  return (
    <ModalShell
      title={state.isNew ? "New freeze window" : `Edit · ${state.displayName || state.id}`}
      icon={<Calendar size={20} className="text-text-muted" />}
      size="focus"
      stackLevel={stackLevel}
      onClose={onCancel}
      footer={
        <>
          <ModalBtnSecondary onClick={onCancel} disabled={state.busy}>Cancel</ModalBtnSecondary>
          <div className="ml-auto">
            <ModalBtnPrimary disabled={state.busy || missing !== null} onClick={() => void save().catch((err: unknown) => { console.error("[mia]", err) })}>
              {state.busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Save
            </ModalBtnPrimary>
          </div>
        </>
      }
    >
      <AdminModalRoot>
        <AdminModalCanvas>
          <FormSectionCard title="Freeze window" emphasized>
            <FormFieldGroup label="Name">
              <input
                value={state.displayName}
                onChange={(e) => onName(e.target.value)}
                placeholder="Month-end close"
                className="input w-full text-sm"
                autoFocus
              />
              {state.id ? (
                <span className="mt-1 font-mono text-xs text-text-faint">
                  id: {state.id}
                  {state.isNew && (
                    <button
                      type="button"
                      onClick={() => patch({ idTouched: !state.idTouched })}
                      className="ml-2 underline hover:text-text-muted"
                    >
                      {state.idTouched ? "auto" : "custom"}
                    </button>
                  )}
                </span>
              ) : null}
            </FormFieldGroup>

            {state.isNew && state.idTouched ? (
              <FormFieldGroup label="Id">
                <input
                  value={state.id}
                  onChange={(e) => patch({ id: e.target.value })}
                  className="input w-full font-mono text-sm"
                />
              </FormFieldGroup>
            ) : null}
          </FormSectionCard>

          <FormSectionCard title="Active period">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormFieldGroup label="Starts">
                <input
                  type="datetime-local"
                  value={state.startsLocal}
                  onChange={(e) => patch({ startsLocal: e.target.value })}
                  className="input w-full text-sm"
                />
              </FormFieldGroup>
              <FormFieldGroup label="Ends">
                <input
                  type="datetime-local"
                  value={state.endsLocal}
                  onChange={(e) => patch({ endsLocal: e.target.value })}
                  className="input w-full text-sm"
                />
              </FormFieldGroup>
            </div>
            <FormFieldGroup label="Description">
              <textarea
                value={state.description}
                onChange={(e) => patch({ description: e.target.value })}
                rows={2}
                className="input w-full text-sm"
              />
            </FormFieldGroup>
          </FormSectionCard>
        </AdminModalCanvas>
      </AdminModalRoot>
    </ModalShell>
  )
}

export { ConfirmModal }
