import { useEffect, useRef } from "react"

/**
 * Keep catalog selection stable across reloads.
 * Applies `initialId` once, then only corrects stale/missing selection.
 */
export function useInitialCatalogSelection<T extends { id: string }>(
  items: readonly T[],
  selectedId: string | null,
  setSelectedId: (id: string | null) => void,
  initialId: string | null | undefined,
): void {
  const appliedInitialRef = useRef(false)

  useEffect(() => {
    if (items.length === 0) return

    if (selectedId && items.some((item) => item.id === selectedId)) {
      return
    }

    if (!appliedInitialRef.current && initialId && items.some((item) => item.id === initialId)) {
      setSelectedId(initialId)
      appliedInitialRef.current = true
      return
    }

    setSelectedId(items[0]!.id)
  }, [items, initialId, selectedId, setSelectedId])
}
