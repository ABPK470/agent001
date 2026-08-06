/**
 * Claim the active operator surface while `enabled`.
 * Handler is read from a ref so the composition root always sees latest peers.
 */

import { useEffect, useRef, type RefObject } from "react"
import {
  claimOperatorSurface,
  type OperatorSurfaceHandler,
} from "../lib/operator-surface"

export function useClaimOperatorSurface(
  enabled: boolean,
  id: string,
  onKeyDownRef: RefObject<OperatorSurfaceHandler | null>,
): void {
  const idRef = useRef(id)
  idRef.current = id

  useEffect(() => {
    if (!enabled) return
    const release = claimOperatorSurface({
      id: idRef.current,
      onKeyDown: (event) => onKeyDownRef.current?.(event) ?? false,
    })
    return release
  }, [enabled, onKeyDownRef])
}
