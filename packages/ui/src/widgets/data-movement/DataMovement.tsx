/**
 * DataMovement widget — thin wrapper around the shell, so it can be mounted
 * on the canvas (WidgetFrame) or opened as a modal (DataMovementModal) from
 * the burger menu.
 */

import { DataMovementShell } from "./DataMovementShell"

export function DataMovement() {
  return <DataMovementShell />
}
