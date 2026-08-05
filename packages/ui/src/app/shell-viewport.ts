/**
 * Dual-mount chat|workspace track: mode is transform, never scrollLeft.
 * Inactive keep-alive panels must not own viewport geometry.
 */

export function pinShellTrackScroll(track: HTMLElement | null | undefined): void {
  if (!track) return
  if (track.scrollLeft !== 0) track.scrollLeft = 0
  if (track.scrollTop !== 0) track.scrollTop = 0
}
