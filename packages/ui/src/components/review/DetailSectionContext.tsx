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

/** Register a collapsible header with the nearest detail-section provider. */
export function useRegisterDetailSection({
  open,
  setOpen,
  headerRef,
}: {
  open: boolean
  setOpen: (open: boolean) => void
  headerRef: RefObject<HTMLElement | null>
}): { id: string; active: boolean } {
  const id = useId()
  const controller = useDetailSectionController()
  const openRef = useRef(open)
  const setOpenRef = useRef(setOpen)
  openRef.current = open
  setOpenRef.current = setOpen

  useEffect(() => {
    if (!controller) return
    return controller.register({
      id,
      getOpen: () => openRef.current,
      setOpen: (next) => {
        if (next !== openRef.current) setOpenRef.current(next)
      },
      headerEl: () => headerRef.current,
    })
  }, [controller, id, headerRef])

  const active = useDetailSectionActive(id)
  return { id, active }
}
