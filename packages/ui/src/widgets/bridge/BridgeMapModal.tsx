/**
 * BridgeMapModal — focus-sized Map workspace.
 * Quiet path context (not decorative chips); body is the TransformMap table.
 */

import type { ConnectorInfo } from "@mia/shared-types"
import { Shuffle } from "lucide-react"
import type { JSX } from "react"
import { META_TEXT, TEXT_BTN, TEXT_BTN_PRIMARY } from "../entity-registry/chrome"
import { ModalShell } from "../entity-registry/ModalShell"
import { ConnectorKindMark } from "../connectors/ConnectorKindMark"
import { TransformMap } from "./TransformMap"
import { summarizeMap } from "./bridge-summaries"
import type { TransformDraft } from "./transform-draft"

export function BridgeMapModal({
  draft,
  onChange,
  sourceColumns,
  onSampleColumns,
  sampling,
  source,
  target,
  onClose,
  stackLevel = 1,
}: {
  draft: TransformDraft
  onChange: (next: TransformDraft) => void
  sourceColumns: readonly string[]
  onSampleColumns?: () => void
  sampling?: boolean
  source: ConnectorInfo | null
  target: ConnectorInfo | null
  onClose: () => void
  stackLevel?: number
}): JSX.Element {
  return (
    <ModalShell
      title="Map"
      subtitle={summarizeMap(draft)}
      icon={<Shuffle size={20} className="text-text-muted" />}
      size="focus"
      stackLevel={stackLevel}
      onClose={onClose}
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <PathLine source={source} target={target} />
          <div className="flex shrink-0 gap-2">
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
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-6 pt-4 pb-2">
        <TransformMap
          draft={draft}
          onChange={onChange}
          sourceColumns={sourceColumns}
          onSampleColumns={onSampleColumns}
          sampling={sampling}
          sourceName={source?.displayName ?? null}
          targetName={target?.displayName ?? null}
        />
      </div>
    </ModalShell>
  )
}

/** Compact path — icons + names in one line, no card chrome. */
function PathLine({
  source,
  target,
}: {
  source: ConnectorInfo | null
  target: ConnectorInfo | null
}): JSX.Element {
  return (
    <p className={`flex min-w-0 items-center gap-1.5 ${META_TEXT}`}>
      {source ? (
        <>
          <ConnectorKindMark kind={source.kind} size={14} title={source.kind} />
          <span className="truncate text-text-secondary">{source.displayName}</span>
        </>
      ) : (
        <span>Source</span>
      )}
      <span className="shrink-0 text-text-faint" aria-hidden>
        →
      </span>
      {target ? (
        <>
          <ConnectorKindMark kind={target.kind} size={14} title={target.kind} />
          <span className="truncate text-text-secondary">{target.displayName}</span>
        </>
      ) : (
        <span>Target</span>
      )}
    </p>
  )
}
