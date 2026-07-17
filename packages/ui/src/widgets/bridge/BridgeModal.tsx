/**
 * BridgeModal — opens the Bridge shell as a near-full-viewport
 * modal from the burger menu. Mirrors ConnectorsModal.
 */

import { ArrowRightLeft } from "lucide-react"
import type { JSX } from "react"
import { ModalShell } from "../entity-registry/ModalShell"
import { BridgeShell } from "./BridgeShell"

export function BridgeModal({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <ModalShell
      title="Bridge"
      subtitle="Move rows between connectors through a declarative transform."
      icon={<ArrowRightLeft size={20} className="text-text-muted" />}
      size="focus"
      stackLevel={0}
      onClose={onClose}
    >
      <BridgeShell />
    </ModalShell>
  )
}
