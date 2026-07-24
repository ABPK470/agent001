import { useSyncExternalStore } from "react"
import {
  clearViewingAs,
  getViewingAsTarget,
  isViewingAsMe,
  setViewingAs,
  subscribeViewingAs,
  type ViewingAsTarget,
} from "../app/viewing-as"
import { useMe } from "./useMe"

function subscribe(onStoreChange: () => void): () => void {
  return subscribeViewingAs(onStoreChange)
}

function getSnapshot(): ViewingAsTarget | null {
  return getViewingAsTarget()
}

export function useViewingAs() {
  const { me } = useMe()
  const target = useSyncExternalStore(subscribe, getSnapshot, () => null)
  const isMe = isViewingAsMe()

  return {
    /** null when Viewing as Me */
    viewingAsUpn: target?.upn ?? null,
    displayName: target?.displayName ?? null,
    isMe,
    /** Quiet accent / disable Personal writes when not Me */
    isViewingAsOther: !isMe,
    setViewingAs: (next: ViewingAsTarget | null) => setViewingAs(next, me?.upn),
    clearViewingAs: () => clearViewingAs(me?.upn),
    /** Admins only — operators always Me */
    canViewAs: !!me?.isAdmin,
  }
}
