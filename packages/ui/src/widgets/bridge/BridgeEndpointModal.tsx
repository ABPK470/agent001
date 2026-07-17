/**
 * BridgeEndpointModal — focused editor for one end of the bridge.
 *
 * Lists every enabled connector. Options that cannot fill this role are
 * visible but disabled, with a hint — so “why isn’t X here?” never happens.
 * The same connector may be used as both source and target when it supports
 * both read and write.
 */

import type { ConnectorInfo, ConnectorKindId } from "@mia/shared-types"
import type { JSX } from "react"
import { Listbox, type ListboxOption } from "../../components/Listbox"
import { HELP_TEXT, TEXT_BTN, TEXT_BTN_PRIMARY } from "../entity-registry/chrome"
import { FormFieldGroup } from "../entity-registry/form-section"
import { ModalShell } from "../entity-registry/ModalShell"
import { ConnectorKindMark } from "../connectors/ConnectorKindMark"
import { ReadSpecForm, WriteSpecForm } from "./spec-forms"

export function BridgeEndpointModal({
  role,
  connectors,
  connectorId,
  spec,
  onConnectorChange,
  onSpecChange,
  onClose,
  stackLevel = 1,
}: {
  role: "source" | "target"
  /** All enabled connectors (not pre-filtered). */
  connectors: ConnectorInfo[]
  connectorId: string
  spec: Record<string, unknown>
  onConnectorChange: (id: string) => void
  onSpecChange: (next: Record<string, unknown>) => void
  onClose: () => void
  stackLevel?: number
}): JSX.Element {
  const options: ListboxOption<string>[] = connectors.map((c) => {
    const ok = role === "source" ? c.capabilities.read : c.capabilities.write
    return {
      value: c.id,
      label: c.displayName,
      hint: ok ? c.kind : role === "source" ? `${c.kind} · cannot read` : `${c.kind} · cannot write`,
      disabled: !ok,
    }
  })
  const selected = connectors.find((c) => c.id === connectorId) ?? null
  const title = role === "source" ? "Source" : "Target"
  const subtitle =
    role === "source"
      ? "Any readable connector. The same connector can also be the target."
      : "Any writable connector. The same connector can also be the source."

  return (
    <ModalShell
      title={title}
      subtitle={subtitle}
      icon={
        selected ? (
          <ConnectorKindMark kind={selected.kind} size={22} title={selected.kind} />
        ) : undefined
      }
      size="focus"
      stackLevel={stackLevel}
      onClose={onClose}
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <p className={`${HELP_TEXT} hidden sm:block`}>
            Greyed connectors lack {role === "source" ? "read" : "write"} for Bridge.
          </p>
          <div className="ml-auto flex gap-2">
            <button type="button" className={TEXT_BTN} onClick={onClose}>
              Cancel
            </button>
            <button type="button" className={TEXT_BTN_PRIMARY} onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      }
    >
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6">
        <FormFieldGroup label="Connector">
          <div className="flex items-center gap-3">
            {selected && (
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-overlay-2">
                <ConnectorKindMark kind={selected.kind} size={28} title={selected.kind} />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <Listbox
                value={connectorId}
                options={options}
                onChange={onConnectorChange}
                size="sm"
                className="w-full"
                ariaLabel={`${title} connector`}
                placeholder={`Select a ${role}…`}
              />
            </div>
          </div>
        </FormFieldGroup>

        {selected && role === "source" && selected.capabilities.read && (
          <ReadSpecForm kind={selected.kind} spec={spec} onPatch={onSpecChange} />
        )}
        {selected && role === "target" && selected.capabilities.write && (
          <WriteSpecForm
            kind={selected.kind as ConnectorKindId}
            spec={spec}
            onPatch={onSpecChange}
          />
        )}
      </div>
    </ModalShell>
  )
}
