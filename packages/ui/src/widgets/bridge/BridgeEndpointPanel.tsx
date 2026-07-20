/**
 * BridgeEndpointCard — Source/Target bubble that expands into its form in place.
 * Path order stays Source | Map | Target; the open end grows on its side.
 */

import type { ConnectorInfo, ConnectorKindId } from "@mia/shared-types"
import { ChevronDown, Settings2 } from "lucide-react"
import type { JSX } from "react"
import { Listbox, type ListboxOption } from "../../components/Listbox"
import { HELP_TEXT, META_TEXT } from "../entity-registry/chrome"
import { FormFieldGroup } from "../entity-registry/form-section"
import { ConnectorKindMark } from "../connectors/ConnectorKindMark"
import { ReadSpecForm, WriteSpecForm } from "./spec-forms"
import { summarizeReadSpec, summarizeWriteSpec } from "./bridge-summaries"

export function BridgeEndpointCard({
  role,
  connectors,
  connectorId,
  spec,
  expanded,
  onToggle,
  onConnectorChange,
  onSpecChange,
  pathPillClassName = "",
}: {
  role: "source" | "target"
  connectors: ConnectorInfo[]
  connectorId: string
  spec: Record<string, unknown>
  expanded: boolean
  onToggle: () => void
  onConnectorChange: (id: string) => void
  onSpecChange: (next: Record<string, unknown>) => void
  /** Shared height with the Map path chip when collapsed. */
  pathPillClassName?: string
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
  const summary = selected
    ? role === "source"
      ? summarizeReadSpec(selected.kind, spec)
      : summarizeWriteSpec(selected.kind, spec)
    : role === "source"
      ? "Choose a source"
      : "Choose a target"

  return (
    <section
      className={[
        "bridge-endpoint flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border transition-colors",
        expanded
          ? "h-full min-h-0 w-full flex-1 border-accent/40 bg-elevated/50 ring-1 ring-inset ring-accent/15"
          // Fixed default chrome — match Map path chip height; width follows the slot.
          : `${pathPillClassName} w-full max-w-[20rem] shrink-0 border-border-subtle bg-elevated/40`,
      ].join(" ")}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        title={expanded ? `Collapse ${title.toLowerCase()}` : `Configure ${title.toLowerCase()}`}
        className={[
          "bridge-endpoint__chrome flex w-full items-center gap-3.5 px-4 py-3.5 text-left transition-colors",
          // Collapsed chrome is identical idle or beside an open peer — only the
          // opened card itself gains the expand affordance (chevron + form).
          expanded ? "shrink-0 border-b border-border-subtle hover:bg-overlay-1/40" : "h-full hover:bg-overlay-1",
        ].join(" ")}
      >
        <div className="bridge-endpoint__mark flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-overlay-2 ring-1 ring-border-subtle/60">
          {selected ? (
            <ConnectorKindMark kind={selected.kind} size={28} title={selected.kind} />
          ) : (
            <Settings2 size={22} className="text-text-faint" aria-hidden />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-text-faint">{title}</div>
          <div className="truncate text-sm font-semibold text-text">
            {selected?.displayName ?? "Select…"}
          </div>
          <div className={`mt-0.5 truncate ${META_TEXT}${expanded ? " invisible" : ""}`}>
            {summary}
          </div>
        </div>
        {expanded ? (
          <ChevronDown size={16} className="shrink-0 text-accent" aria-hidden />
        ) : (
          <Settings2 size={16} className="shrink-0 text-text-faint" aria-hidden />
        )}
      </button>

      {expanded && (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto p-4 sm:p-5">
            <div className="min-w-0 shrink-0">
              <FormFieldGroup label="Connector">
                <Listbox
                  value={connectorId}
                  options={options}
                  onChange={onConnectorChange}
                  size="sm"
                  className="w-full min-w-0"
                  ariaLabel={`${title} connector`}
                  placeholder={`Select a ${role}…`}
                />
              </FormFieldGroup>
            </div>

            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
              {selected && role === "source" && selected.capabilities.read && (
                <ReadSpecForm kind={selected.kind} spec={spec} onPatch={onSpecChange} />
              )}
              {selected && role === "target" && selected.capabilities.write && (
                <WriteSpecForm
                  kind={selected.kind as ConnectorKindId}
                  spec={spec}
                  onPatch={onSpecChange}
                  connectorId={connectorId || undefined}
                />
              )}
            </div>
          </div>
          <p className={`shrink-0 border-t border-border-subtle px-4 py-2 ${HELP_TEXT}`}>
            Greyed connectors lack {role === "source" ? "read" : "write"} for Bridge.
          </p>
        </div>
      )}
    </section>
  )
}
