/**
 * History modal — same shell as EnvSync definition/history modals.
 */

import { History } from "lucide-react"
import type { JSX } from "react"
import type { EntityRegistryHistoryEntry } from "../../types"
import { ModalShell } from "./ModalShell"
import { EntityHistory } from "./EntityHistory"

export function EntityHistoryModal({
  entityId,
  entries,
  onClose,
}: {
  entityId: string
  entries: EntityRegistryHistoryEntry[]
  onClose: () => void
}): JSX.Element {
  return (
    <ModalShell
      title="History"
      subtitle={entityId}
      icon={<History size={20} className="text-text-muted" />}
      size="detail"
      onClose={onClose}
    >
      <div className="entity-registry modal-detail-body p-5">
        <EntityHistory entries={entries} />
      </div>
    </ModalShell>
  )
}
