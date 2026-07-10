/**
 * Inline target editor — same form chrome as Configuration flows/actions/wiring.
 */

import type { JSX } from "react"
import { useEffect, useMemo, useRef } from "react"

import { Listbox, type ListboxOption } from "../../../components/Listbox"
import type { SyncEnvironmentAdmin } from "../../../types"
import { FormFieldGroup, FormSectionCard } from "../form-section"
import { HELP_TEXT } from "../chrome"
import { FormCheck } from "../../sync-admin/shared"
import {
  deriveAllowedOperations,
  denyFlagsForAccessMode,
  OP_LABELS,
  suggestAccessForName,
} from "../../sync-admin/env-access"
import type { TargetFormSnapshot } from "./target-form-model"

const ROLE_OPTIONS: ListboxOption<SyncEnvironmentAdmin["role"]>[] = [
  { value: "source", label: "source" },
  { value: "target", label: "target" },
  { value: "both", label: "both" },
]

const ACCESS_MODE_OPTIONS: ListboxOption<SyncEnvironmentAdmin["defaultAccessMode"]>[] = [
  { value: "read_only", label: "read_only" },
  { value: "read_write", label: "read_write" },
]

export function SyncTargetForm({
  value,
  onChange,
  mode,
  readOnly = false,
}: {
  value: TargetFormSnapshot
  onChange: (next: TargetFormSnapshot) => void
  mode: "create" | "edit"
  readOnly?: boolean
}): JSX.Element {
  const effectiveOps = useMemo(
    () => deriveAllowedOperations(value.defaultAccessMode, value.denyDml, value.denyDdl),
    [value.defaultAccessMode, value.denyDml, value.denyDdl],
  )

  const lastSuggestedNameRef = useRef("")

  useEffect(() => {
    if (mode !== "create" || readOnly) return
    const trimmed = value.name.trim()
    if (!trimmed || trimmed === lastSuggestedNameRef.current) return
    lastSuggestedNameRef.current = trimmed
    const suggested = suggestAccessForName(trimmed)
    onChange({
      ...value,
      defaultAccessMode: suggested.defaultAccessMode,
      denyDml: suggested.denyDml,
      denyDdl: suggested.denyDdl,
    })
  }, [mode, onChange, readOnly, value])

  function patch(fields: Partial<TargetFormSnapshot>): void {
    onChange({ ...value, ...fields })
  }

  function onAccessModeChange(modeValue: SyncEnvironmentAdmin["defaultAccessMode"]): void {
    const flags = denyFlagsForAccessMode(modeValue)
    onChange({
      ...value,
      defaultAccessMode: modeValue,
      denyDml: flags.denyDml,
      denyDdl: flags.denyDdl,
    })
  }

  const accessReadOnly = readOnly || value.defaultAccessMode === "read_only"

  return (
    <div className="space-y-3">
      {readOnly && (
        <p className={HELP_TEXT}>
          Built-in target is locked. Unlock from the toolbar to edit dev, uat, or prod.
        </p>
      )}

      <FormSectionCard
        title="Identity"
        description="Name must match MSSQL_DATABASES in .env."
        emphasized
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormFieldGroup label="Name" hint={mode === "edit" ? "Locked after create." : undefined}>
            <input
              value={value.name}
              disabled={readOnly || mode === "edit"}
              onChange={(event) => patch({ name: event.target.value })}
              className="input font-mono text-sm"
              placeholder="dev"
            />
          </FormFieldGroup>
          <FormFieldGroup label="Display name">
            <input
              value={value.displayName}
              disabled={readOnly}
              onChange={(event) => patch({ displayName: event.target.value })}
              className="input text-sm"
              placeholder="Development"
            />
          </FormFieldGroup>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <FormFieldGroup label="Color">
            <input
              value={value.color}
              disabled={readOnly}
              onChange={(event) => patch({ color: event.target.value })}
              className="input text-sm"
            />
          </FormFieldGroup>
          <FormFieldGroup label="Role">
            <Listbox
              value={value.role}
              options={ROLE_OPTIONS}
              onChange={(role) => patch({ role })}
              size="sm"
              className="w-full"
              ariaLabel="Role"
              disabled={readOnly}
            />
          </FormFieldGroup>
          <FormFieldGroup label="Order">
            <input
              value={value.ringOrder}
              disabled={readOnly}
              onChange={(event) => patch({ ringOrder: event.target.value })}
              className="input font-mono text-sm"
            />
          </FormFieldGroup>
        </div>
      </FormSectionCard>

      <FormSectionCard
        title="Access"
        description="Default access mode and write blocks for this target."
      >
        <FormFieldGroup label="Access mode">
          <Listbox
            value={value.defaultAccessMode}
            options={ACCESS_MODE_OPTIONS}
            onChange={onAccessModeChange}
            size="sm"
            className="w-full"
            ariaLabel="Access"
            disabled={readOnly}
          />
        </FormFieldGroup>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormCheck
            label="Block DML"
            checked={value.denyDml}
            disabled={readOnly || accessReadOnly}
            onChange={(denyDml) => patch({ denyDml })}
          />
          <FormCheck
            label="Block DDL"
            checked={value.denyDdl}
            disabled={readOnly || accessReadOnly}
            onChange={(denyDdl) => patch({ denyDdl })}
          />
        </div>
        <div className="flex flex-wrap gap-1.5 pt-1">
          {effectiveOps.map((op) => (
            <span
              key={op}
              className="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-xs font-mono text-accent"
              title={OP_LABELS[op]}
            >
              {op}
            </span>
          ))}
        </div>
      </FormSectionCard>

      <FormSectionCard
        title="Service URLs"
        description="Optional endpoints for agent, ETL, and gate services."
      >
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
          <FormFieldGroup label="Agent URL">
            <input
              value={value.agentServiceBaseUrl}
              disabled={readOnly}
              onChange={(event) => patch({ agentServiceBaseUrl: event.target.value })}
              className="input font-mono text-sm"
            />
          </FormFieldGroup>
          <FormFieldGroup label="ETL URL">
            <input
              value={value.etlServiceBaseUrl}
              disabled={readOnly}
              onChange={(event) => patch({ etlServiceBaseUrl: event.target.value })}
              className="input font-mono text-sm"
            />
          </FormFieldGroup>
          <FormFieldGroup label="Gate URL">
            <input
              value={value.gateServiceBaseUrl}
              disabled={readOnly}
              onChange={(event) => patch({ gateServiceBaseUrl: event.target.value })}
              className="input font-mono text-sm"
            />
          </FormFieldGroup>
        </div>
      </FormSectionCard>

      <FormSectionCard title="Sync scope">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormFieldGroup label="Sync targets" hint="Comma-separated target names">
            <textarea
              value={value.allowedTargetsText}
              disabled={readOnly}
              onChange={(event) => patch({ allowedTargetsText: event.target.value })}
              rows={3}
              className="input font-mono text-sm"
            />
          </FormFieldGroup>
          <FormFieldGroup label="Entity allowlist" hint="Comma-separated entity ids">
            <textarea
              value={value.syncAllowlistText}
              disabled={readOnly}
              onChange={(event) => patch({ syncAllowlistText: event.target.value })}
              rows={3}
              className="input font-mono text-sm"
            />
          </FormFieldGroup>
        </div>
      </FormSectionCard>
    </div>
  )
}
