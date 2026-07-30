/**
 * Bridge widget — thin wrapper around the shell, so it can be mounted
 * on the canvas (WidgetShell) or opened as a modal (BridgeModal) from
 * the burger menu.
 */

import { BridgeShell } from "./BridgeShell"

export function Bridge() {
  return <BridgeShell />
}
