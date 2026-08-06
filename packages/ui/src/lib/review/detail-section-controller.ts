/**
 * Keyboard-addressable detail rows — accordion sections and plain rows (timeline).
 * ↑↓ move · ←→ / Space fold/toggle when the active row is foldable.
 */

export type DetailSectionHandle = {
  id: string
  headerEl: () => HTMLElement | null
  /** Omit for non-foldable rows (timeline events). */
  getOpen?: () => boolean
  setOpen?: (open: boolean) => void
}

export type DetailSectionController = {
  register: (handle: DetailSectionHandle) => () => void
  activate: (id: string) => boolean
  move: (direction: -1 | 1) => boolean
  toggle: () => boolean
  fold: (open: boolean) => boolean
  clearActive: () => void
  getActiveId: () => string | null
  subscribe: (listener: () => void) => () => void
}

function isFoldable(handle: DetailSectionHandle): boolean {
  return typeof handle.getOpen === "function" && typeof handle.setOpen === "function"
}

export function createDetailSectionController(): DetailSectionController {
  let sections: DetailSectionHandle[] = []
  let activeId: string | null = null
  const listeners = new Set<() => void>()

  function notify() {
    for (const listener of listeners) listener()
  }

  function indexOfActive(): number {
    if (!activeId) return -1
    return sections.findIndex((section) => section.id === activeId)
  }

  function activate(index: number): boolean {
    const section = sections[index]
    if (!section) return false
    activeId = section.id
    section.headerEl()?.scrollIntoView({ block: "nearest" })
    notify()
    return true
  }

  function ensureActive(): DetailSectionHandle | null {
    if (sections.length === 0) return null
    const current = indexOfActive()
    if (current >= 0) return sections[current]!
    activate(0)
    return sections[0] ?? null
  }

  return {
    register(handle) {
      const existing = sections.findIndex((section) => section.id === handle.id)
      if (existing >= 0) sections[existing] = handle
      else sections = [...sections, handle]
      notify()
      return () => {
        sections = sections.filter((section) => section.id !== handle.id)
        if (activeId === handle.id) activeId = null
        notify()
      }
    },

    activate(id) {
      const index = sections.findIndex((section) => section.id === id)
      if (index < 0) return false
      return activate(index)
    },

    move(direction) {
      if (sections.length === 0) return false
      const current = indexOfActive()
      if (current < 0) {
        return activate(direction > 0 ? 0 : sections.length - 1)
      }
      const next = current + direction
      if (next < 0 || next >= sections.length) return false
      return activate(next)
    },

    toggle() {
      const section = ensureActive()
      if (!section || !isFoldable(section)) return false
      section.setOpen!(!section.getOpen!())
      return true
    },

    fold(open) {
      const section = ensureActive()
      if (!section || !isFoldable(section)) return false
      section.setOpen!(open)
      return true
    },

    clearActive() {
      if (activeId === null) return
      activeId = null
      notify()
    },

    getActiveId() {
      return activeId
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
