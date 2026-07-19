import type { JSX } from "react"

import { Listbox, type ListboxOption } from "../../../components/Listbox"
import { FormCheck } from "../../sync-admin/shared"
import { HELP_TEXT } from "../chrome"
import { FormFieldGroup, FormSectionCard } from "../form-section"
import type { DirectionPolicyMode, EnvironmentFormSnapshot } from "./environment-form-model"
import { ENV_POLICY_ALLOWED_CLASS } from "./environment-form-layout"

const DIRECTION_POLICY_OPTIONS: ListboxOption<DirectionPolicyMode>[] = [
  { value: "unrestricted", label: "Unrestricted", hint: "Any environment allowed when this env is source" },
  { value: "restricted", label: "Restricted list", hint: "Only selected environments allowed" },
  { value: "blocked", label: "Blocked", hint: "No outgoing syncs from this env" },
]

export function SyncPolicySection({
  value,
  peerEnvironments,
  readOnly,
  onChange,
}: {
  value: Pick<EnvironmentFormSnapshot, "directionPolicy" | "allowedDirections">
  peerEnvironments: Array<{ name: string; displayName: string }>
  readOnly?: boolean
  onChange: (patch: Partial<EnvironmentFormSnapshot>) => void
}): JSX.Element {
  const peers = peerEnvironments.filter((target) => target.name.trim())

  function setDirectionChecked(name: string, checked: boolean): void {
    const normalized = name.trim()
    const selected = new Set(value.allowedDirections)
    if (checked) selected.add(normalized)
    else selected.delete(normalized)
    onChange({ allowedDirections: [...selected] })
  }

  function onPolicyChange(directionPolicy: DirectionPolicyMode): void {
    onChange({
      directionPolicy,
      allowedDirections: directionPolicy === "restricted" ? value.allowedDirections : [],
    })
  }

  return (
    <FormSectionCard
      title="Outgoing directions"
      description="Felt in the Sync widget From/To lists and enforced again on preview/execute."
    >
      <p className={HELP_TEXT}>
        When this environment is the <strong>source</strong>, which environments it may sync to.
      </p>

      <FormFieldGroup label="Policy">
        <Listbox
          value={value.directionPolicy}
          options={DIRECTION_POLICY_OPTIONS}
          onChange={onPolicyChange}
          size="sm"
          className="listbox-control w-full"
          ariaLabel="Outgoing direction policy"
          disabled={readOnly}
        />
      </FormFieldGroup>

      {value.directionPolicy === "restricted" && (
        <div className={ENV_POLICY_ALLOWED_CLASS}>
          <p className="text-xs font-medium uppercase tracking-wide text-text-faint">Allowed environments</p>
          {peers.length === 0 ? (
            <p className={HELP_TEXT}>No other environments configured yet.</p>
          ) : (
            <div className="flex w-full min-w-0 flex-col gap-2">
              {peers.map((target) => (
                <FormCheck
                  key={target.name}
                  label={`${target.displayName} (${target.name})`}
                  checked={value.allowedDirections.includes(target.name)}
                  disabled={readOnly}
                  onChange={(checked) => setDirectionChecked(target.name, checked)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </FormSectionCard>
  )
}
