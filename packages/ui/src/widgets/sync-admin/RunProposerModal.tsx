import { Loader2, Play } from "lucide-react"
import type { JSX } from "react"
import { useMemo, useState } from "react"
import { api } from "../../api"
import { Listbox, type ListboxOption } from "../../components/Listbox"
import type { SyncEnvironmentAdmin } from "../../types"
import { FormField, ModalBtnPrimary, ModalBtnSecondary, ModalShell } from "./chrome"
import { useConsole } from "./console-context"

export function RunProposerModal({
  connections,
  onClose,
  onStarted,
}: {
  connections: SyncEnvironmentAdmin[]
  onClose: () => void
  onStarted?: (source: string, target: string) => void
}): JSX.Element {
  const { notify, notifyError } = useConsole()
  const options = useMemo<ListboxOption<string>[]>(
    () => connections.map((c) => ({ value: c.name, label: c.name })),
    [connections],
  )
  const [source, setSource] = useState(connections[0]?.name ?? "")
  const [target, setTarget] = useState(connections[1]?.name ?? connections[0]?.name ?? "")
  const [busy, setBusy] = useState(false)

  async function run(): Promise<void> {
    if (!source || !target) return notifyError("Pick source and target")
    if (source === target) return notifyError("Source and target must differ")
    setBusy(true)
    try {
      await api.triggerProposerRun(source, target)
      onStarted?.(source, target)
      notify(`Scan started · ${source} → ${target}`)
      onClose()
    } catch (e) {
      notifyError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalShell
      title="Run scan"
      subtitle={`${source || "source"} → ${target || "target"}`}
      size="detail"
      onClose={onClose}
      footer={
        <>
          <ModalBtnSecondary onClick={onClose} disabled={busy}>Cancel</ModalBtnSecondary>
          <div className="ml-auto">
            <ModalBtnPrimary onClick={() => void run()} disabled={busy || !source || !target}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              Start
            </ModalBtnPrimary>
          </div>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 px-6 py-5 sm:grid-cols-2 text-sm">
        <FormField label="Source" hint="Connection to read from">
          <Listbox value={source} options={options} onChange={setSource} size="sm" className="w-full" ariaLabel="Source" />
        </FormField>
        <FormField label="Target" hint="Connection to compare against">
          <Listbox value={target} options={options} onChange={setTarget} size="sm" className="w-full" ariaLabel="Target" />
        </FormField>
      </div>
    </ModalShell>
  )
}
