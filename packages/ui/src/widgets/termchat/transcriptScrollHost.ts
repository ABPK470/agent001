/**
 * Dual-mount shells keep chat + workspace TermChat alive. Selection sync must
 * not call scrollIntoView from the inactive host — browsers will scroll
 * ancestors and yank the viewport onto the off-screen chat panel.
 */

export function transcriptHostScrollAllowed(flags: {
  connected: boolean
  underAriaHidden: boolean
  underInactivePanel: boolean
  panelVisibility: string | null
}): boolean {
  if (!flags.connected) return false
  if (flags.underAriaHidden) return false
  if (flags.underInactivePanel) return false
  // visibility:hidden still participates in scrollIntoView ancestor walks.
  if (flags.panelVisibility === "hidden") return false
  return true
}

export function transcriptHostMayScroll(host: HTMLElement | null | undefined): boolean {
  if (!host?.isConnected) return false
  const panel = host.closest(".app-shell-panel")
  return transcriptHostScrollAllowed({
    connected: true,
    underAriaHidden: Boolean(host.closest('[aria-hidden="true"]')),
    underInactivePanel: Boolean(host.closest(".app-shell-panel--inactive")),
    panelVisibility:
      panel instanceof HTMLElement ? getComputedStyle(panel).visibility : null,
  })
}
