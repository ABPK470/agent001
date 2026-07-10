/**
 * Tracks nested modal shells for escape handling and popover z-index.
 */

import { dismissOpenPopovers } from "./popover-dismiss"

export const MODAL_BASE_Z = 50
export const MODAL_Z_STEP = 10

const modalStack: string[] = []

export function pushModalStack(id: string): void {
  modalStack.push(id)
  dismissOpenPopovers()
}

export function popModalStack(id: string): void {
  const idx = modalStack.lastIndexOf(id)
  if (idx >= 0) modalStack.splice(idx, 1)
}

export function getModalStackDepth(): number {
  return modalStack.length
}

export function isTopModalStack(id: string): boolean {
  return modalStack[modalStack.length - 1] === id
}

/** Popover z-index: above parent modal content, below any newly opened modal shell. */
export function popoverZIndex(): number {
  const depth = getModalStackDepth()
  if (depth <= 0) return 1000
  return MODAL_BASE_Z + Math.max(0, depth - 1) * MODAL_Z_STEP + 8
}
