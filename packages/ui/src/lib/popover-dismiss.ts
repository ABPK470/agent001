/**
 * Global coordinator for portaled popovers (Listbox, SearchablePick, …).
 *
 * - Only one popover may be open at a time across the app.
 * - Opening a new popover closes any other registered instance.
 * - Modal shells dismiss every open popover when they mount.
 */

type PopoverCloseFn = () => void

const instances = new Map<string, PopoverCloseFn>()
let openInstanceId: string | null = null

export function registerPopoverInstance(id: string, close: PopoverCloseFn): () => void {
  instances.set(id, close)
  return () => {
    instances.delete(id)
    if (openInstanceId === id) openInstanceId = null
  }
}

/** Close every registered popover except the one being opened. */
export function dismissOtherPopovers(exceptId?: string): void {
  for (const [id, close] of instances) {
    if (id !== exceptId) close()
  }
}

/** Mark this popover as the sole open instance, closing the previous one first. */
export function claimPopoverOpen(id: string): void {
  if (openInstanceId && openInstanceId !== id) {
    instances.get(openInstanceId)?.()
  }
  openInstanceId = id
}

export function releasePopoverOpen(id: string): void {
  if (openInstanceId === id) openInstanceId = null
}

/** Close all registered popovers (e.g. when a modal layers on top). */
export function dismissOpenPopovers(): void {
  dismissOtherPopovers()
  openInstanceId = null
}

/** @deprecated Use registerPopoverInstance */
export function subscribePopoverDismiss(listener: PopoverCloseFn): () => void {
  const id = `popover-${instances.size + 1}`
  return registerPopoverInstance(id, listener)
}
