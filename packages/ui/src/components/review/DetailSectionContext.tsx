/**
 * Detail-pane accordion keyboard — provider + registration for Review/Trace collapsibles.
 */

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react"
import {
  createDetailSectionController,
  type DetailSectionController,
} from "../../lib/review/detail-section-controller"

const DetailSectionContext = createContext<DetailSectionController | null>(null)

export function DetailSectionProvider({
  children,
  controllerRef,
}: {
  children: ReactNode
  /** Optional host ref so operator keyboard can drive the same controller. */
  controllerRef?: RefObject<DetailSectionController | null>
}) {
  const controller = useMemo(() => createDetailSectionController(), [])
  // Sync host ref during render so operator keyboard never races an empty useEffect.
  if (controllerRef) controllerRef.current = controller

  useEffect(() => {
    if (!controllerRef) return
    controllerRef.current = controller
    return () => {
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [controller, controllerRef])

  return (
    <DetailSectionContext.Provider value={controller}>{children}</DetailSectionContext.Provider>
  )
}

export function useDetailSectionController(): DetailSectionController | null {
  return useContext(DetailSectionContext)
}

export function useDetailSectionActive(id: string): boolean {
  const controller = useDetailSectionController()
  return useSyncExternalStore(
    (onStoreChange) => controller?.subscribe(onStoreChange) ?? (() => {}),
    () => (controller ? controller.getActiveId() === id : false),
    () => false,
  )
}

export type DetailSectionPeekBinding = {
  hasPeek: boolean
  expanded: boolean
  setExpanded: (open: boolean) => void
}

/** Register a collapsible header with the nearest detail-section provider. */
export function useRegisterDetailSection({
  open,
  setOpen,
  headerRef,
  peek,
}: {
  open: boolean
  setOpen: (open: boolean) => void
  headerRef: RefObject<HTMLElement | null>
  /** Nested More/Less under this section (←→ peels one level). */
  peek?: DetailSectionPeekBinding | null
}): { id: string; active: boolean; activate: () => void } {
  const id = useId()
  const controller = useDetailSectionController()
  const openRef = useRef(open)
  const setOpenRef = useRef(setOpen)
  const peekRef = useRef(peek)
  openRef.current = open
  setOpenRef.current = setOpen
  peekRef.current = peek

  useEffect(() => {
    if (!controller) return
    return controller.register({
      id,
      getOpen: () => openRef.current,
      setOpen: (next) => {
        if (next !== openRef.current) setOpenRef.current(next)
      },
      headerEl: () => headerRef.current,
      hasPeek: () => Boolean(peekRef.current?.hasPeek),
      getPeekOpen: () => peekRef.current?.expanded ?? false,
      setPeekOpen: (next) => {
        const binding = peekRef.current
        if (!binding?.hasPeek) return
        if (next !== binding.expanded) binding.setExpanded(next)
      },
    })
  }, [controller, id, headerRef])

  const active = useDetailSectionActive(id)

  function activate() {
    controller?.activate(id)
  }

  return { id, active, activate }
}

/** Register a non-foldable detail row (timeline event, step, …). */
export function useRegisterDetailRow(
  rowRef: RefObject<HTMLElement | null>,
): { id: string; active: boolean; activate: () => void } {
  const id = useId()
  const controller = useDetailSectionController()

  useEffect(() => {
    if (!controller) return
    return controller.register({
      id,
      headerEl: () => rowRef.current,
    })
  }, [controller, id, rowRef])

  const active = useDetailSectionActive(id)

  function activate() {
    controller?.activate(id)
  }

  return { id, active, activate }
}
