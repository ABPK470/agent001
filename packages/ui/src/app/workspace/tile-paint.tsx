/**
 * Per-tile paint window — solo-hidden tiles stay mounted but skip UI commits.
 */

import { createContext, useContext, type ReactNode } from "react"

export interface TilePaintValue {
  /** Sibling under maximize — keep streams warm; freeze Trace / list projections. */
  soloHidden: boolean
}

const TilePaintContext = createContext<TilePaintValue>({ soloHidden: false })

export function TilePaintProvider({
  soloHidden,
  children,
}: TilePaintValue & { children: ReactNode }) {
  return (
    <TilePaintContext.Provider value={{ soloHidden }}>
      {children}
    </TilePaintContext.Provider>
  )
}

export function useTilePaint(): TilePaintValue {
  return useContext(TilePaintContext)
}
