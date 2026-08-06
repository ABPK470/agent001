/**
 * Keyboard-addressable detail accordions — one active section per detail pane.
 * Hosts register on mount; operator keys move / toggle / fold via this controller.
 */

export type DetailSectionHandle = {
  id: string
  getOpen: () => boolean
  setOpen: (open: boolean) => void
  headerEl: () => HTMLElement | null
}

export type DetailSectionController = {
  register: (handle: DetailSectionHandle) => () => void
  /** Point ←→ / Space at a section (click / focus). */
  activate: (id: string) => boolean
  move: (direction: -1 | 1) => boolean
  toggle: () => boolean
  fold: (open: boolean) => boolean
  clearActive: () => void
  getActiveId: () => string | null
  subscribe: (listener: () => void) => () => void
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
      const next = (current + direction + sections.length) % sections.length
      return activate(next)
    },

    toggle() {
      const section = ensureActive()
      if (!section) return false
      section.setOpen(!section.getOpen())
      return true
    },

    fold(open) {
      const section = ensureActive()
      if (!section) return false
      section.setOpen(open)
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
