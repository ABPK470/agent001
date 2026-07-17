import { Plus } from "lucide-react"
import type { JSX } from "react"
import { useState } from "react"
import { api } from "../../client/index"
import { Listbox, type ListboxOption } from "../../components/Listbox"
import { ModalBtnPrimary, ModalBtnSecondary, ModalShell } from "./chrome"
import { useConsole } from "./console-context"
import {
  AdminModalCanvas,
  AdminModalRoot,
  FormFieldGroup,
  FormSectionCard,
} from "./modal-layout"
import { FormCheck } from "./shared"

type Channel = "email" | "teams" | "slack"

const CHANNEL_OPTIONS: ListboxOption<Channel>[] = [
  { value: "email", label: "email" },
  { value: "teams", label: "teams" },
  { value: "slack", label: "slack" },
]

export function RouteEditorModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }): JSX.Element {
  const { notify, notifyError } = useConsole()
  const [eventType, setEventType] = useState("sync.approval.requested")
  const [channel, setChannel] = useState<Channel>("email")
  const [target, setTarget] = useState("")
  const [filter, setFilter] = useState("{}")
  const [enabled, setEnabled] = useState(true)
  const [busy, setBusy] = useState(false)

  async function save(): Promise<void> {
    if (!target.trim()) return notifyError("Target is required")
    setBusy(true)
    try {
      const parsed = JSON.parse(filter) as Record<string, unknown>
      await api.upsertNotificationRoute({ eventType, channel, target: target.trim(), filter: parsed, enabled })
      notify("Route saved")
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
      title="New route"
      subtitle="Event notifications"
      size="focus"
      onClose={onClose}
      footer={
        <>
          <ModalBtnSecondary onClick={onClose} disabled={busy}>Cancel</ModalBtnSecondary>
          <div className="ml-auto">
            <ModalBtnPrimary onClick={() => void save()} disabled={busy}>
              <Plus size={14} /> Save
            </ModalBtnPrimary>
          </div>
        </>
      }
    >
      <AdminModalRoot>
        <AdminModalCanvas>
          <FormSectionCard title="Routing" description="Match platform events and deliver to a channel target.">
            <FormFieldGroup label="Event type">
              <input className="input w-full font-mono text-sm" value={eventType} onChange={(e) => setEventType(e.target.value)} />
            </FormFieldGroup>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormFieldGroup label="Channel">
                <Listbox value={channel} options={CHANNEL_OPTIONS} onChange={setChannel} size="sm" className="w-full" ariaLabel="Channel" />
              </FormFieldGroup>
              <FormFieldGroup label="Target" hint="Email address or webhook URL">
                <input className="input w-full font-mono text-sm" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="ops@corp" />
              </FormFieldGroup>
            </div>
          </FormSectionCard>

          <FormSectionCard title="Filter & status">
            <FormFieldGroup label="Filter JSON" hint="Optional payload matcher — empty object matches all.">
              <textarea className="input min-h-[88px] w-full font-mono text-xs" value={filter} onChange={(e) => setFilter(e.target.value)} spellCheck={false} />
            </FormFieldGroup>
            <FormCheck label="Enabled" checked={enabled} onChange={setEnabled} />
          </FormSectionCard>
        </AdminModalCanvas>
      </AdminModalRoot>
    </ModalShell>
  )
}
