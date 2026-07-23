import { Plus } from "lucide-react"
import type { JSX } from "react"
import { useMemo, useState } from "react"
import { api } from "../../client/index"
import { Listbox, type ListboxOption } from "../../components/Listbox"
import type { SyncEnvironmentAdmin } from "../../types"
import { ModalBtnPrimary, ModalBtnSecondary, ModalShell } from "./chrome"
import { useConsole } from "./console-context"
import { AdminModalCanvas, AdminModalRoot, FormFieldGroup, FormSectionCard } from "./modal-layout"
import { FormCheck } from "./shared"

export function ScheduleEditorModal({
  connections,
  onClose,
  onSaved,
}: {
  connections: SyncEnvironmentAdmin[]
  onClose: () => void
  onSaved: () => void
}): JSX.Element {
  const { notify, notifyError } = useConsole()
  const options = useMemo<ListboxOption<string>[]>(
    () => connections.map((c) => ({ value: c.name, label: c.name })),
    [connections],
  )
  const [source, setSource] = useState(connections[0]?.name ?? "")
  const [target, setTarget] = useState(connections[1]?.name ?? connections[0]?.name ?? "")
  const [cron, setCron] = useState("0 */6 * * *")
  const [enabled, setEnabled] = useState(true)
  const [busy, setBusy] = useState(false)

  async function save(): Promise<void> {
    if (!source || !target) return notifyError("Pick source and target")
    setBusy(true)
    try {
      await api.upsertProposerSchedule({ source, target, cron, enabled })
      notify("Schedule saved")
      onSaved()
      onClose()
    } catch (e) {
      notifyError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalShell
      title="New schedule"
      subtitle="UTC cron"
      size="focus"
      onClose={onClose}
      footer={
        <>
          <ModalBtnSecondary onClick={onClose} disabled={busy}>Cancel</ModalBtnSecondary>
          <div className="ml-auto">
            <ModalBtnPrimary onClick={() => void save().catch((err: unknown) => { console.error("[mia]", err) })} disabled={busy}>
              <Plus size={14} /> Save
            </ModalBtnPrimary>
          </div>
        </>
      }
    >
      <AdminModalRoot>
        <AdminModalCanvas>
          <FormSectionCard title="Connection pair" description="Proposer runs from source to target on this cadence.">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormFieldGroup label="Source">
                <Listbox value={source} options={options} onChange={setSource} size="sm" className="w-full" ariaLabel="Source" />
              </FormFieldGroup>
              <FormFieldGroup label="Target">
                <Listbox value={target} options={options} onChange={setTarget} size="sm" className="w-full" ariaLabel="Target" />
              </FormFieldGroup>
            </div>
          </FormSectionCard>

          <FormSectionCard title="Schedule" description="Five-field cron expression evaluated in UTC.">
            <FormFieldGroup label="Cron" hint="minute hour dom month dow">
              <input className="input w-full font-mono text-sm" value={cron} onChange={(e) => setCron(e.target.value)} />
            </FormFieldGroup>
            <FormCheck
              label="Enabled"
              hint="Disabled schedules are kept but do not run."
              checked={enabled}
              onChange={setEnabled}
            />
          </FormSectionCard>
        </AdminModalCanvas>
      </AdminModalRoot>
    </ModalShell>
  )
}
