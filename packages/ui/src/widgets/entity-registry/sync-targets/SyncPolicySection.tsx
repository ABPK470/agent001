import type { JSX } from "react"

import { Listbox, type ListboxOption } from "../../../components/Listbox"
import { FormCheck } from "../../sync-admin/shared"
import { HELP_TEXT } from "../chrome"
import { FormFieldGroup, FormSectionCard } from "../form-section"
import type { DirectionPolicyMode, TargetFormSnapshot } from "./target-form-model"

const DIRECTION_POLICY_OPTIONS: ListboxOption<DirectionPolicyMode>[] = [
  { value: "unrestricted", label: "Unrestricted", hint: "Any target allowed when this env is source" },
  { value: "restricted", label: "Restricted list", hint: "Only selected targets allowed" },
  { value: "blocked", label: "Blocked", hint: "No outgoing syncs from this env" },
]

export function SyncPolicySection({
  value,
  peerTargets,
  readOnly,
  onChange,
}: {
  value: Pick<TargetFormSnapshot, "directionPolicy" | "allowedDirections">
  peerTargets: Array<{ name: string; displayName: string }>
  readOnly?: boolean
  onChange: (patch: Partial<TargetFormSnapshot>) => void
}): JSX.Element {
  const peers = peerTargets.filter((target) => target.name.trim())

  function toggleDirection(name: string): void {
    const normalized = name.trim()
    const selected = new Set(value.allowedDirections)
    if (selected.has(normalized)) selected.delete(normalized)
    else selected.add(normalized)
    onChange({ allowedDirections: [...selected] })
  }

  return (
    <FormSectionCard
      title="Outgoing directions"
      description="Server-enforced on preview and execute. The sync widget still lists all environments — invalid pairs fail at run time."
    >
      <p className={HELP_TEXT}>
        When this environment is the <strong>source</strong>, which targets it may sync to.
      </p>

      <FormFieldGroup label="Policy">
        <Listbox
          value={value.directionPolicy}
          options={DIRECTION_POLICY_OPTIONS}
          onChange={(directionPolicy) => onChange({ directionPolicy })}
          size="sm"
          className="w-full"
          ariaLabel="Outgoing direction policy"
          disabled={readOnly}
        />
      </FormFieldGroup>

      {value.directionPolicy === "restricted" && (
        <div className="space-y-2 rounded-lg border border-border-subtle bg-base/20 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-text-faint">Allowed targets</p>
          {peers.length === 0 ? (
            <p className={HELP_TEXT}>No other targets configured yet.</p>
          ) : (
            peers.map((target) => (
              <FormCheck
                key={target.name}
                label={`${target.displayName} (${target.name})`}
                checked={value.allowedDirections.includes(target.name)}
                disabled={readOnly}
                onChange={() => toggleDirection(target.name)}
              />
            ))
          )}
        </div>
      )}
    </FormSectionCard>
  )
}
