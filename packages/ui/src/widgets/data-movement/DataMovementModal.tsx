/**
 * DataMovementModal — opens the Data Movement shell as a near-full-viewport
 * modal from the burger menu. Mirrors ConnectorsModal.
 */

import { ArrowRightLeft } from "lucide-react"
import type { JSX } from "react"
import { ModalShell } from "../entity-registry/ModalShell"
import { DataMovementShell } from "./DataMovementShell"

export function DataMovementModal({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <ModalShell
      title="Data movement"
      subtitle="Move rows between connectors through a declarative transform."
      icon={<ArrowRightLeft size={20} className="text-text-muted" />}
      size="focus"
      stackLevel={0}
      onClose={onClose}
    >
      <DataMovementShell />
    </ModalShell>
  )
}
