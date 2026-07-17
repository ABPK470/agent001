/**
 * ConnectorsModal — opens the Connectors shell as a near-full-viewport
 * modal from the burger menu. Works in both the workspace and chat shells
 * (mounted locally in SessionMenu, unlike WidgetModal which is
 * workspace-only).
 */

import type { JSX } from "react"
import { ModalShell } from "../entity-registry/ModalShell"
import { CONNECTOR_ICON } from "./kind-icon"
import { ConnectorsShell } from "./ConnectorsShell"

export function ConnectorsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const Icon = CONNECTOR_ICON
  return (
    <ModalShell
      title="Connectors"
      subtitle="Managed connections to external data sources."
      icon={<Icon size={20} className="text-text-muted" />}
      size="focus"
      stackLevel={0}
      onClose={onClose}
    >
      <ConnectorsShell />
    </ModalShell>
  )
}
