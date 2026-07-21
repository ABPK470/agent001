/**
 * Inline target editor — same form chrome as Configuration flows/actions/wiring.
 */

import type { JSX } from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { api } from "../../../client/index"
import { Listbox, type ListboxOption } from "../../../components/Listbox"
import { conflictForSyncEnvironment, writeEnabledForConnectorId } from "../../../lib/connector-write-capability"
import type { ConnectorAdmin, SyncEnvironmentAdmin } from "../../../types"
import { FormFieldGroup, FormSectionCard } from "../form-section"
import { HELP_TEXT } from "../chrome"
import { FormCheck } from "../../sync-admin/shared"
import {
  deriveAllowedOperations,
  denyFlagsForAccessMode,
  OP_LABELS,
  suggestAccessForName,
} from "../../sync-admin/env-access"
import { CapabilityConflictBanner } from "../../platform/CapabilityConflictBanner"
import { EnvColorPicker } from "./EnvColorPicker"
import { ServiceUrlsField } from "./ServiceUrlsField"
import { SyncPolicySection } from "./SyncPolicySection"
import type { ServiceUrlEntry, EnvironmentFormSnapshot } from "./environment-form-model"
import { ENV_FORM_ROOT_CLASS } from "./environment-form-layout"

const ROLE_OPTIONS: ListboxOption<SyncEnvironmentAdmin["role"]>[] = [
  { value: "source", label: "source" },
  { value: "target", label: "target" },
  { value: "both", label: "both" },
]

const ACCESS_MODE_OPTIONS: ListboxOption<SyncEnvironmentAdmin["defaultAccessMode"]>[] = [
  { value: "read_only", label: "read_only" },
  { value: "read_write", label: "read_write" },
]

export function SyncEnvironmentForm({
  value,
  onChange,
  mode,
  readOnly = false,
  stackLevel = 1,
  peerEnvironments = [],
}: {
  value: EnvironmentFormSnapshot
  onChange: (next: EnvironmentFormSnapshot) => void
  mode: "create" | "edit"
  readOnly?: boolean
  stackLevel?: number
  peerEnvironments?: Array<{ name: string; displayName: string }>
}): JSX.Element {
  const effectiveOps = useMemo(
    () => deriveAllowedOperations(value.defaultAccessMode, value.denyDml, value.denyDdl),
    [value.defaultAccessMode, value.denyDml, value.denyDdl],
  )

  const lastSuggestedNameRef = useRef("")
  const valueRef = useRef(value)
  valueRef.current = value

  const [connectors, setConnectors] = useState<ConnectorAdmin[]>([])
  useEffect(() => {
    let alive = true
    void api.listConnectors().then((rows) => {
      if (alive) setConnectors([...rows].sort((a, b) => a.id.localeCompare(b.id)))
    }).catch(() => { /* admin-only surface; ignore load errors silently */ })
    return () => { alive = false }
  }, [])

  const connectorOptions: ListboxOption<string>[] = useMemo(() => {
    const none: ListboxOption<string> = { value: "", label: "None", hint: "No linked connector" }
    const opts: ListboxOption<string>[] = connectors.map((c) => {
      const selectable = c.kind === "mssql" && c.enabled
      const writeOn = writeEnabledForConnectorId(connectors, c.id) === true
      const hint =
        c.kind !== "mssql"
          ? `${c.kind} (Sync needs MSSQL)`
          : !c.enabled
            ? "disabled — enable in Connectors"
            : writeOn
              ? "mssql · Write on"
              : "mssql · read-only"
      return {
        value: c.id,
        label: c.displayName,
        hint,
        disabled: !selectable,
      }
    })
    return [none, ...opts]
  }, [connectors])

  const writeConflict = useMemo(
    () =>
      conflictForSyncEnvironment(
        {
          name: value.name.trim() || "(unnamed)",
          connectorId: value.connectorId,
          allowedOperations: effectiveOps,
        },
        connectors,
      ),
    [value.name, value.connectorId, effectiveOps, connectors],
  )

  function onConnectorChange(id: string): void {
    const next = id || null
    if (mode === "create" && !value.name.trim()) {
      const conn = connectors.find((c) => c.id === id)
      if (conn) {
        onChange({ ...valueRef.current, connectorId: next, name: conn.name })
        return
      }
    }
    patch({ connectorId: next })
  }

  const patch = useCallback(
    (fields: Partial<EnvironmentFormSnapshot>) => {
      onChange({ ...valueRef.current, ...fields })
    },
    [onChange],
  )

  useEffect(() => {
    if (mode !== "create" || readOnly) return
    const trimmed = value.name.trim()
    if (!trimmed || trimmed === lastSuggestedNameRef.current) return
    lastSuggestedNameRef.current = trimmed
    const suggested = suggestAccessForName(trimmed)
    onChange({
      ...valueRef.current,
      defaultAccessMode: suggested.defaultAccessMode,
      denyDml: suggested.denyDml,
      denyDdl: suggested.denyDdl,
    })
  }, [mode, onChange, readOnly, value.name])

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
  const policyPeers = peerEnvironments.filter((target) => target.name !== value.name)

  const handleServiceUrlsChange = useCallback(
    (serviceUrls: ServiceUrlEntry[]) => patch({ serviceUrls }),
    [patch],
  )

  return (
    <div className={ENV_FORM_ROOT_CLASS}>
      {readOnly && (
        <p className={HELP_TEXT}>
          Built-in environment is locked. Unlock from the toolbar to edit dev, uat, or prod.
        </p>
      )}

      <FormSectionCard
        title="Identity"
        description="Logical Sync place. Link an enabled MSSQL connector for pools; name is a free-form slug."
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
        <FormFieldGroup
          label="Connector"
          hint="Enabled MSSQL connectors only. Enable a connector in Connectors before linking."
        >
          <Listbox
            value={value.connectorId ?? ""}
            options={connectorOptions}
            onChange={onConnectorChange}
            size="sm"
            className="listbox-control w-full"
            ariaLabel="Connector"
            disabled={readOnly}
          />
        </FormFieldGroup>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <EnvColorPicker
            value={value.color}
            disabled={readOnly}
            onChange={(color) => patch({ color })}
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormFieldGroup label="Role">
            <Listbox
              value={value.role}
              options={ROLE_OPTIONS}
              onChange={(role) => patch({ role })}
              size="sm"
              className="listbox-control w-full"
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
        description="Governance for this environment (policy seeding). Connector Write is a separate hard ceiling — both must allow for sync execute / DML to succeed."
      >
        <FormFieldGroup label="Access mode">
          <Listbox
            value={value.defaultAccessMode}
            options={ACCESS_MODE_OPTIONS}
            onChange={onAccessModeChange}
            size="sm"
            className="listbox-control w-full"
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
        {writeConflict && <CapabilityConflictBanner conflict={writeConflict} className="mt-3" />}
      </FormSectionCard>

      <ServiceUrlsField
        entries={value.serviceUrls}
        readOnly={readOnly}
        stackLevel={stackLevel}
        onChange={handleServiceUrlsChange}
      />

      <SyncPolicySection
        value={value}
        peerEnvironments={policyPeers}
        readOnly={readOnly}
        onChange={patch}
      />
    </div>
  )
}
