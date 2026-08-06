/**
 * Active operator surface — at most one widget owns in-pane keys.
 * Composition root reads this; widgets claim/release via useClaimOperatorSurface.
 */

export type OperatorSurfaceHandler = (event: KeyboardEvent) => boolean

export type OperatorSurface = {
  id: string
  onKeyDown: OperatorSurfaceHandler
}

let active: OperatorSurface | null = null

/** Claim focus for in-pane chords. Returns release. */
export function claimOperatorSurface(surface: OperatorSurface): () => void {
  active = surface
  return () => {
    if (active === surface) active = null
  }
}

export function getActiveOperatorSurface(): OperatorSurface | null {
  return active
}

/** Test helper — clear between cases. */
export function resetOperatorSurfaceForTests(): void {
  active = null
}
