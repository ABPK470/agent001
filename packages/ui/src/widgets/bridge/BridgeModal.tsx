/**
 * BridgeModal — opens Bridge from the session menu.
 */

import { ArrowRightLeft } from "lucide-react"
import type { JSX } from "react"
import { ModalShell } from "../entity-registry/ModalShell"
import { BridgeShell } from "./BridgeShell"

export function BridgeModal({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <ModalShell
      title="Bridge"
      subtitle="Move rows from one connector to another."
      icon={<ArrowRightLeft size={20} className="text-text-muted" />}
      size="focus"
      stackLevel={0}
      onClose={onClose}
    >
      <BridgeShell />
    </ModalShell>
  )
}
